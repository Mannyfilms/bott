const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'access.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Create tables
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

// Add session_token column if it doesn't exist (migration)
try {
  db.exec('ALTER TABLE users ADD COLUMN session_token TEXT');
} catch(e) { /* column already exists */ }

/**
 * Generate a short, readable access code
 */
function generateCode() {
  // Format: XXXX-XXXX (8 chars, easy to type)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O/1/I confusion
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

/**
 * Get or create an access code for a Discord user
 */
function getOrCreateUser(discordId, discordUsername) {
  // Check if user already exists
  const existing = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
  
  if (existing) {
    // Update username in case it changed
    db.prepare('UPDATE users SET discord_username = ? WHERE discord_id = ?')
      .run(discordUsername, discordId);
    return { code: existing.access_code, isNew: false };
  }

  // Create new user with unique code
  const code = generateCode();
  db.prepare('INSERT INTO users (discord_id, discord_username, access_code) VALUES (?, ?, ?)')
    .run(discordId, discordUsername, code);
  
  return { code, isNew: true };
}

/**
 * Verify an access code — returns user info or null
 */
function verifyCode(code) {
  const normalized = code.toUpperCase().trim();
  const user = db.prepare(
    'SELECT * FROM users WHERE access_code = ? AND is_active = 1'
  ).get(normalized);

  if (user) {
    // Generate new session token — this invalidates any previous session
    const sessionToken = crypto.randomUUID();
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP, session_token = ? WHERE id = ?')
      .run(sessionToken, user.id);
    user.session_token = sessionToken;
  }

  return user || null;
}

/**
 * Check if a session token is still valid (hasn't been replaced by a newer login)
 */
function isSessionValid(discordId, sessionToken) {
  const user = db.prepare(
    'SELECT session_token FROM users WHERE discord_id = ? AND is_active = 1'
  ).get(discordId);
  return user && user.session_token === sessionToken;
}

/**
 * Revoke a user's access
 */
function revokeUser(discordId) {
  const result = db.prepare('UPDATE users SET is_active = 0 WHERE discord_id = ?')
    .run(discordId);
  return result.changes > 0;
}

/**
 * Get all active users (admin)
 */
function getAllUsers() {
  return db.prepare('SELECT discord_id, discord_username, access_code, created_at, last_login FROM users WHERE is_active = 1').all();
}

module.exports = {
  getOrCreateUser,
  verifyCode,
  isSessionValid,
  revokeUser,
  getAllUsers
};
