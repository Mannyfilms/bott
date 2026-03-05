const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'access.db');

const fs = require('fs');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ─── Users table ───
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
try { db.exec('ALTER TABLE users ADD COLUMN session_token TEXT'); } catch(e) {}

// ─── Prediction log (per-slot records for win rate tracking) ───
db.exec(`
  CREATE TABLE IF NOT EXISTS prediction_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    slot_ts INTEGER NOT NULL,
    direction TEXT NOT NULL,
    confidence INTEGER DEFAULT 0,
    resolved INTEGER DEFAULT 0,
    actual_direction TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(type, slot_ts)
  );
`);

// ─── Persistent server state (survives restarts) ───
db.exec(`
  CREATE TABLE IF NOT EXISTS server_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─────────────────────────────────────────────────────────
//  USER FUNCTIONS
// ─────────────────────────────────────────────────────────

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
  if (user) {
    const sessionToken = crypto.randomUUID();
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP, session_token = ? WHERE id = ?').run(sessionToken, user.id);
    user.session_token = sessionToken;
  }
  return user || null;
}

function isSessionValid(discordId, sessionToken) {
  const user = db.prepare('SELECT session_token FROM users WHERE discord_id = ? AND is_active = 1').get(discordId);
  return user && user.session_token === sessionToken;
}

function revokeUser(discordId) {
  const result = db.prepare('UPDATE users SET is_active = 0 WHERE discord_id = ?').run(discordId);
  return result.changes > 0;
}

function getAllUsers() {
  return db.prepare('SELECT discord_id, discord_username, access_code, created_at, last_login FROM users WHERE is_active = 1').all();
}

// ─────────────────────────────────────────────────────────
//  PREDICTION TRACKING
// ─────────────────────────────────────────────────────────

/**
 * Record a new prediction for a slot.
 * type: 'hourly' | 'fivemin'
 * slotTs: unix seconds timestamp for the slot start
 * direction: 'UP' | 'DOWN'
 * confidence: 50-100
 */
function recordPrediction(type, slotTs, direction, confidence) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO prediction_log (type, slot_ts, direction, confidence)
      VALUES (?, ?, ?, ?)
    `).run(type, slotTs, direction, confidence || 0);
  } catch(e) { /* ignore */ }
}

/**
 * Mark a prediction as resolved with the actual outcome.
 * Returns true if a record was updated.
 */
function resolvePrediction(type, slotTs, actualDirection) {
  const result = db.prepare(`
    UPDATE prediction_log
    SET resolved = 1, actual_direction = ?
    WHERE type = ? AND slot_ts = ? AND resolved = 0
  `).run(actualDirection, type, slotTs);
  return result.changes > 0;
}

/**
 * Get win rate stats for a type.
 */
function getWinRate(type) {
  const rows = db.prepare(`
    SELECT direction, actual_direction
    FROM prediction_log
    WHERE type = ? AND resolved = 1
    ORDER BY slot_ts DESC
  `).all(type);

  let wins = 0, losses = 0;
  rows.forEach(r => {
    if (r.direction === r.actual_direction) wins++;
    else losses++;
  });

  const total = wins + losses;
  const rate = total > 0 ? (wins / total * 100).toFixed(1) : null;

  // Current streak
  let streak = 0, streakWin = null;
  for (const r of rows) {
    const correct = r.direction === r.actual_direction;
    if (streakWin === null) { streakWin = correct; streak = 1; }
    else if (correct === streakWin) streak++;
    else break;
  }

  // Last 10 results for display
  const last10 = rows.slice(0, 10).map(r => ({
    direction: r.direction,
    actual: r.actual_direction,
    correct: r.direction === r.actual_direction
  }));

  return { wins, losses, total, rate, streak, streakWin, last10 };
}

/**
 * Get unresolved predictions older than minAgeSecs seconds.
 */
function getUnresolvedPredictions(type, minAgeSecs = 370) {
  const cutoff = Math.floor(Date.now() / 1000) - minAgeSecs;
  return db.prepare(`
    SELECT id, slot_ts, direction, confidence
    FROM prediction_log
    WHERE type = ? AND resolved = 0 AND slot_ts < ?
    ORDER BY slot_ts ASC
    LIMIT 20
  `).all(type, cutoff);
}

// ─────────────────────────────────────────────────────────
//  SERVER STATE PERSISTENCE
// ─────────────────────────────────────────────────────────

function saveState(key, value) {
  db.prepare(`
    INSERT OR REPLACE INTO server_state (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `).run(key, JSON.stringify(value));
}

function loadState(key) {
  const row = db.prepare('SELECT value FROM server_state WHERE key = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch(e) { return null; }
}

module.exports = {
  getOrCreateUser,
  verifyCode,
  isSessionValid,
  revokeUser,
  getAllUsers,
  recordPrediction,
  resolvePrediction,
  getWinRate,
  getUnresolvedPredictions,
  saveState,
  loadState
};
