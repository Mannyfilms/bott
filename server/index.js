const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { verifyCode } = require('./database.js');

// Start Discord bot
require('../bot/index.js');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.API_SECRET || 'change-this-to-a-random-string';

app.use(express.json());
app.use(cookieParser());

// ─── Auth Middleware ───
function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// ─── API Routes ───

// Verify access code and create session
app.post('/api/verify', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const user = verifyCode(code);
  if (!user) return res.status(403).json({ error: 'Invalid or revoked code' });

  // Create JWT session token (7 day expiry)
  const token = jwt.sign(
    { discordId: user.discord_id, username: user.discord_username },
    SECRET,
    { expiresIn: '7d' }
  );

  // Set as HTTP-only cookie
  res.cookie('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  return res.json({
    success: true,
    username: user.discord_username
  });
});

// Check if current session is valid
app.get('/api/me', requireAuth, (req, res) => {
  return res.json({
    authenticated: true,
    username: req.user.username
  });
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  return res.json({ success: true });
});

// ─── Polymarket PTB Proxy ───
// Scrapes the actual PTB from the Polymarket website
app.get('/api/polymarket-ptb', async (req, res) => {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 300);
    
    for (const ts of [windowTs, windowTs - 300]) {
      const slug = 'btc-updown-5m-' + ts;
      const url = 'https://polymarket.com/event/' + slug;
      
      try {
        // Fetch the actual Polymarket page
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });
        if (!resp.ok) continue;
        const html = await resp.text();
        
        // Look for PTB in the page HTML
        // Polymarket shows it as "PRICE TO BEAT" followed by "$XX,XXX.XX"
        // Try multiple patterns
        const patterns = [
          /PRICE\s*TO\s*BEAT[^$]*\$([0-9,]+\.\d{1,2})/i,
          /price.?to.?beat[^$]*\$([0-9,]+\.\d{1,2})/i,
          /\"startPrice\":\s*\"?([0-9.]+)/i,
          /\"priceToBeat\":\s*\"?([0-9.]+)/i,
          /target[^$]*\$([0-9,]+\.\d{1,2})/i,
        ];
        
        let ptb = null;
        for (const pat of patterns) {
          const match = html.match(pat);
          if (match) {
            const val = parseFloat(match[1].replace(/,/g, ''));
            if (val > 50000 && val < 200000) { // BTC price range
              ptb = val;
              break;
            }
          }
        }
        
        // Also try to find ALL dollar amounts in BTC range from the page
        if (!ptb) {
          const allPrices = html.match(/\$([0-9,]{5,6}\.\d{1,2})/g) || [];
          for (const p of allPrices) {
            const val = parseFloat(p.replace(/[$,]/g, ''));
            if (val > 50000 && val < 200000) {
              ptb = val;
              break;
            }
          }
        }
        
        // Also try the gamma API as backup
        let upPrice = null, downPrice = null;
        try {
          const apiResp = await fetch('https://gamma-api.polymarket.com/events?slug=' + slug);
          if (apiResp.ok) {
            const data = await apiResp.json();
            if (data && data.length > 0) {
              const mkt = data[0].markets && data[0].markets[0];
              if (mkt) {
                try {
                  const prices = JSON.parse(mkt.outcomePrices || '[]');
                  const outcomes = JSON.parse(mkt.outcomes || '[]');
                  outcomes.forEach((o, i) => {
                    if (o.toLowerCase().includes('up')) upPrice = parseFloat(prices[i]);
                    if (o.toLowerCase().includes('down')) downPrice = parseFloat(prices[i]);
                  });
                } catch(e) {}
              }
            }
          }
        } catch(e) {}
        
        if (ptb || upPrice) {
          return res.json({
            slug, timestamp: ts, ptb, upPrice, downPrice,
            source: ptb ? 'website-scrape' : 'api-only'
          });
        }
      } catch(ex) { continue; }
    }
    
    res.json({ ptb: null, error: 'Could not scrape PTB from Polymarket' });
  } catch (e) {
    res.json({ ptb: null, error: e.message });
  }
});

// Fetch Polymarket Up/Down odds for current 5-min BTC market
app.get('/api/polymarket-odds', async (req, res) => {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 300);
    
    for (const ts of [windowTs, windowTs - 300]) {
      const slug = 'btc-updown-5m-' + ts;
      try {
        const resp = await fetch('https://gamma-api.polymarket.com/events?slug=' + slug);
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data && data.length > 0 && data[0].markets && data[0].markets[0]) {
          const mkt = data[0].markets[0];
          const prices = JSON.parse(mkt.outcomePrices || '[]');
          const outcomes = JSON.parse(mkt.outcomes || '[]');
          
          let upPrice = null, downPrice = null;
          outcomes.forEach((o, i) => {
            if (o.toLowerCase().includes('up')) upPrice = parseFloat(prices[i]);
            if (o.toLowerCase().includes('down')) downPrice = parseFloat(prices[i]);
          });
          
          // Also try to extract PTB from description
          const allText = [mkt.description, mkt.question, data[0].title].filter(Boolean).join(' ');
          const priceMatch = allText.match(/\$([0-9,]+\.\d+)/);
          const ptb = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;
          
          return res.json({ upPrice, downPrice, ptb, slug });
        }
      } catch (ex) { continue; }
    }
    res.json({ upPrice: null, downPrice: null, ptb: null });
  } catch (e) {
    res.json({ upPrice: null, downPrice: null, error: e.message });
  }
});

// ─── Serve Frontend ───

// Protected app page
app.get('/app', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

// Login page (always accessible)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Redirect root to login or app
app.get('/', (req, res) => {
  const token = req.cookies?.session;
  if (token) {
    try {
      jwt.verify(token, SECRET);
      return res.redirect('/app');
    } catch (e) { /* invalid token, show login */ }
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Start Server ───
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
});
