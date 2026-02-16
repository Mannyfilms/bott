const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { getOrCreateUser, revokeUser } = require('../server/database.js');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN) {
  console.error('DISCORD_TOKEN not set! Bot will not start.');
  return;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('getaccess').setDescription('Get your personal access code for the BTC Prediction dashboard'),
    new SlashCommandBuilder().setName('mycode').setDescription('View your existing access code'),
    new SlashCommandBuilder().setName('revoke').setDescription('Revoke access for a user (admin only)')
      .addUserOption(opt => opt.setName('user').setDescription('The user to revoke').setRequired(true))
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

client.once('ready', async () => {
  console.log('Discord bot logged in as ' + client.user.tag);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user, member } = interaction;

  if (commandName === 'getaccess') {
    try {
      const { code, isNew } = getOrCreateUser(user.id, user.username);
      await interaction.reply({
        content: isNew
          ? '**Your access code:**\n\n`' + code + '`\n\nEnter this on the website to log in. This code is tied to your Discord account. Use `/mycode` anytime to see it again.'
          : '**Your access code:**\n\n`' + code + '`\n\nSame code as before. Enter it on the website to log in.',
        ephemeral: true
      });
    } catch (error) {
      await interaction.reply({ content: 'Something went wrong. Try again.', ephemeral: true });
    }
  }

  if (commandName === 'mycode') {
    try {
      const { code } = getOrCreateUser(user.id, user.username);
      await interaction.reply({ content: 'Your code: `' + code + '`', ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true });
    }
  }

  if (commandName === 'revoke') {
    if (!member.permissions.has('Administrator')) {
      return interaction.reply({ content: 'You need Administrator permission.', ephemeral: true });
    }
    const targetUser = interaction.options.getUser('user');
    const revoked = revokeUser(targetUser.id);
    await interaction.reply({
      content: revoked ? 'Access revoked for **' + targetUser.username + '**.' : 'No active access found for that user.',
      ephemeral: true
    });
  }
});

client.on('guildMemberRemove', (member) => {
  revokeUser(member.id);
  console.log(member.user.username + ' left - access revoked');
});

client.login(TOKEN);
