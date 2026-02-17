const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'access.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT UNIQUE NOT NULL,
    discord_username TEXT NOT NULL,
    access_code TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active INTEGER DEFAULT 1,
    session_token TEXT
  );
`);

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

function getOrCreateUser(discordId, discordUsername) {
  const existing = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
  if (existing) {
    db.prepare('UPDATE users SET discord_username = ? WHERE discord_id = ?').run(discordUsername, discordId);
    return { code: existing.access_code, isNew: false };
  }
  const code = generateCode();
  db.prepare('INSERT INTO users (discord_id, discord_username, access_code) VALUES (?, ?, ?)').run(discordId, discordUsername, code);
  return { code, isNew: true };
}

function verifyCode(code) {
  const normalized = code.toUpperCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE access_code = ? AND is_active = 1').get(normalized);
  if (user) db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  return user || null;
}

function setSession(discordId, token) {
  db.prepare('UPDATE users SET session_token = ? WHERE discord_id = ?').run(token, discordId);
}

function checkSession(discordId, token) {
  const user = db.prepare('SELECT session_token FROM users WHERE discord_id = ?').get(discordId);
  return user && user.session_token === token;
}

function revokeUser(discordId) {
  return db.prepare('UPDATE users SET is_active = 0 WHERE discord_id = ?').run(discordId).changes > 0;
}

module.exports = { getOrCreateUser, verifyCode, setSession, checkSession, revokeUser };
