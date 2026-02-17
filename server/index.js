const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { getOrCreateUser, revokeUser } = require('../server/database.js');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const REQUIRED_ROLE_ID = '1472956989461237811';

if (!TOKEN) {
  console.error('DISCORD_TOKEN not set!');
  return;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('getaccess').setDescription('Get your personal access code'),
    new SlashCommandBuilder().setName('mycode').setDescription('View your existing access code'),
    new SlashCommandBuilder().setName('revoke').setDescription('Revoke access (admin only)')
      .addUserOption(opt => opt.setName('user').setDescription('User to revoke').setRequired(true))
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    }
    console.log('Slash commands registered');
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
}

function hasRole(member) {
  return member.roles.cache.has(REQUIRED_ROLE_ID);
}

client.once('ready', async () => {
  console.log('Discord bot logged in as ' + client.user.tag);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const { commandName, user, member } = interaction;

    if (commandName === 'getaccess') {
      if (!hasRole(member)) {
        await interaction.reply({ content: 'You need the **Subscriber** role to access this.', ephemeral: true });
        return;
      }
      const { code, isNew } = getOrCreateUser(user.id, user.username);
      await interaction.reply({
        content: isNew
          ? '**Your access code:**\n\n`' + code + '`\n\nEnter this on the website to log in. Use `/mycode` to see it again.'
          : '**Your access code:**\n\n`' + code + '`\n\nSame code as before.',
        ephemeral: true
      });
      return;
    }

    if (commandName === 'mycode') {
      if (!hasRole(member)) {
        await interaction.reply({ content: 'You need the **Subscriber** role.', ephemeral: true });
        return;
      }
      const { code } = getOrCreateUser(user.id, user.username);
      await interaction.reply({ content: 'Your code: `' + code + '`', ephemeral: true });
      return;
    }

    if (commandName === 'revoke') {
      if (!member.permissions.has('Administrator')) {
        await interaction.reply({ content: 'You need Administrator permission.', ephemeral: true });
        return;
      }
      const targetUser = interaction.options.getUser('user');
      const revoked = revokeUser(targetUser.id);
      await interaction.reply({
        content: revoked ? 'Access revoked for **' + targetUser.username + '**.' : 'No active access found.',
        ephemeral: true
      });
      return;
    }
  } catch (error) {
    console.error('Command error:', error);
    if (!interaction.replied) {
      await interaction.reply({ content: 'Something went wrong. Try again.', ephemeral: true }).catch(() => {});
    }
  }
});

client.on('guildMemberRemove', (member) => {
  revokeUser(member.id);
  console.log(member.user.username + ' left - access revoked');
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

client.login(TOKEN);
