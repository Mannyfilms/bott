const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { verifyCode, setSession, checkSession } = require('./database.js');

require('../bot/index.js');

const app = express();
const PORT = process.env.PORT || 8080;
const SECRET = process.env.API_SECRET || 'change-this-to-a-random-string';

app.use(express.json());
app.use(cookieParser());

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, SECRET);
    if (!checkSession(payload.discordId, payload.sessionId)) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Session expired. Someone else may have logged in with your code.' });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

app.post('/api/verify', (req, res) => {
  const { code } = req.body;
  console.log('Login attempt with code:', code);
  if (!code) return res.status(400).json({ error: 'Code required' });
  const user = verifyCode(code);
  console.log('Verify result:', user ? user.discord_username : 'NOT FOUND');
  if (!user) return res.status(403).json({ error: 'Invalid or revoked code' });
  const sessionId = crypto.randomBytes(16).toString('hex');
  setSession(user.discord_id, sessionId);
  const token = jwt.sign(
    { discordId: user.discord_id, username: user.discord_username, sessionId: sessionId },
    SECRET,
    { expiresIn: '7d' }
  );
  res.cookie('session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
  return res.json({ success: true, username: user.discord_username });
});

app.get('/api/me', requireAuth, (req, res) => {
  return res.json({ authenticated: true, username: req.user.username });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  return res.json({ success: true });
});

app.get('/app', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  const token = req.cookies?.session;
  if (token) {
    try {
      const payload = jwt.verify(token, SECRET);
      if (checkSession(payload.discordId, payload.sessionId)) {
        return res.redirect('/app');
      }
    } catch (e) {}
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
