const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { verifyCode, isSessionValid } = require('./database.js');

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
    
    // Must have sessionToken (old JWTs without it are invalid)
    if (!payload.sessionToken || !payload.discordId) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    
    // Check if this session is still the active one
    if (!isSessionValid(payload.discordId, payload.sessionToken)) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Someone else logged in with your access code. This session has been invalidated.' });
    }
    
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

  // Create JWT session token (7 day expiry) with unique session ID
  const token = jwt.sign(
    { discordId: user.discord_id, username: user.discord_username, sessionToken: user.session_token },
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

// ─── Server-side PTB storage (persists across devices) ───
let serverPtb = { price: null, slot: null, timestamp: null };

app.post('/api/ptb', requireAuth, (req, res) => {
  const { price, slot } = req.body;
  if (price && price > 50000 && price < 200000 && slot) {
    serverPtb = { price, slot, timestamp: Date.now() };
  }
  res.json({ ok: true });
});

app.get('/api/ptb', requireAuth, (req, res) => {
  const currentSlot = Math.floor(Date.now() / 300000);
  if (serverPtb.price && serverPtb.slot === currentSlot) {
    return res.json({ price: serverPtb.price, slot: serverPtb.slot });
  }
  res.json({ price: null });
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  return res.json({ success: true });
});

// ─── Smart Whale Tracker: Find & follow the best BTC 5-min trader ───
let topTraderCache = { wallet: null, username: null, winRate: 0, lastDiscovery: 0 };
let whaleCache = { trades: null, lastFetch: 0 };

// Discover the best performing BTC 5-min trader from recent markets
async function discoverTopTrader() {
  // Only rediscover every 5 minutes
  if (topTraderCache.wallet && Date.now() - topTraderCache.lastDiscovery < 300000) {
    return topTraderCache;
  }
  
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const traderStats = {}; // wallet -> {wins, losses, totalSize, username}
    
    // Look at the last 6 resolved 5-min BTC markets (30 min of history)
    for (let i = 2; i <= 7; i++) {
      const slotTs = nowSec - (nowSec % 300) - (i * 300);
      const slug = 'btc-updown-5m-' + slotTs;
      
      try {
        // Get the market's condition_id from Gamma
        const evtResp = await fetch('https://gamma-api.polymarket.com/events?slug=' + slug);
        if (!evtResp.ok) continue;
        const evtData = await evtResp.json();
        if (!evtData || !evtData.length || !evtData[0].markets || !evtData[0].markets[0]) continue;
        
        const mkt = evtData[0].markets[0];
        const conditionId = mkt.conditionId;
        const outcomes = JSON.parse(mkt.outcomes || '[]');
        const outcomePrices = JSON.parse(mkt.outcomePrices || '[]');
        
        // Determine which outcome won (price near 1.0 = winner)
        let winner = null;
        outcomes.forEach((o, idx) => {
          const p = parseFloat(outcomePrices[idx] || 0);
          if (p > 0.9) winner = o; // "Up" or "Down"
        });
        if (!winner) continue;
        
        // Get top traders for this resolved market
        // Use the token_id to find trades
        const tokens = mkt.clobTokenIds ? JSON.parse(mkt.clobTokenIds) : [];
        if (tokens.length === 0) continue;
        
        // Get recent trades for this market from CLOB
        const tradesResp = await fetch('https://clob.polymarket.com/trades?asset_id=' + tokens[0] + '&limit=50');
        if (!tradesResp.ok) continue;
        const trades = await tradesResp.json();
        
        if (!Array.isArray(trades)) continue;
        
        trades.forEach(trade => {
          const wallet = trade.maker_address || trade.taker_address;
          if (!wallet) return;
          
          // Did this trade bet on the winner?
          const betUp = (trade.side === 'BUY' && trade.outcome === 'Up') || (trade.side === 'SELL' && trade.outcome === 'Down');
          const betDown = !betUp;
          const wasRight = (winner === 'Up' && betUp) || (winner === 'Down' && betDown);
          const size = parseFloat(trade.size || trade.matchSize || 0);
          
          if (!traderStats[wallet]) traderStats[wallet] = { wins: 0, losses: 0, totalSize: 0, username: trade.name || trade.pseudonym || wallet.slice(0,8) };
          if (wasRight) traderStats[wallet].wins++;
          else traderStats[wallet].losses++;
          traderStats[wallet].totalSize += size;
        });
      } catch(e) { continue; }
    }
    
    // Find the trader with the best win rate (min 3 trades)
    let bestWallet = null, bestRate = 0, bestUsername = '';
    Object.entries(traderStats).forEach(([wallet, stats]) => {
      const total = stats.wins + stats.losses;
      if (total >= 3) {
        const rate = stats.wins / total;
        if (rate > bestRate || (rate === bestRate && stats.totalSize > (traderStats[bestWallet]?.totalSize || 0))) {
          bestRate = rate;
          bestWallet = wallet;
          bestUsername = stats.username;
        }
      }
    });
    
    if (bestWallet) {
      topTraderCache = { wallet: bestWallet, username: bestUsername, winRate: bestRate, lastDiscovery: Date.now() };
      console.log('🏆 Top trader: ' + bestUsername + ' (' + (bestRate * 100).toFixed(0) + '% win rate)');
    }
    
    return topTraderCache;
  } catch(e) {
    console.log('Trader discovery error:', e.message);
    return topTraderCache;
  }
}

app.get('/api/whale-trades', async (req, res) => {
  try {
    // Cache for 10 seconds
    if (whaleCache.trades && Date.now() - whaleCache.lastFetch < 10000) {
      return res.json(whaleCache.trades);
    }
    
    // Find the best trader
    const topTrader = await discoverTopTrader();
    
    const nowSec = Math.floor(Date.now() / 1000);
    const currentSlotTs = nowSec - (nowSec % 300);
    const currentSlug = 'btc-updown-5m-' + currentSlotTs;
    
    let whaleBet = null;
    let latestTrade = null;
    let allTrades = [];
    
    if (topTrader.wallet) {
      try {
        const resp = await fetch('https://data-api.polymarket.com/activity?address=' + topTrader.wallet + '&limit=10');
        if (resp.ok) {
          const activity = await resp.json();
          
          // Filter for current BTC 5-min slot
          const slotTrades = activity.filter(t => 
            t.eventSlug && t.eventSlug === currentSlug
          );
          
          slotTrades.forEach(t => {
            const direction = t.side === 'BUY' 
              ? (t.outcome === 'Up' ? 'YES' : 'NO')
              : (t.outcome === 'Up' ? 'NO' : 'YES');
            
            allTrades.push({
              username: topTrader.username,
              side: t.side,
              outcome: t.outcome,
              direction,
              price: t.price,
              size: parseFloat(t.usdcSize || t.size || 0),
              timestamp: t.timestamp,
              slug: t.eventSlug
            });
          });
          
          if (allTrades.length > 0) {
            latestTrade = allTrades[0];
            whaleBet = latestTrade.direction;
          }
        }
      } catch(e) {}
    }
    
    const result = {
      whaleBet,
      topTrader: topTrader.username || 'Searching...',
      winRate: topTrader.winRate,
      latestTrade,
      recentTrades: allTrades,
      totalTradesFound: allTrades.length,
      confidence: topTrader.winRate
    };
    
    whaleCache = { trades: result, lastFetch: Date.now() };
    return res.json(result);
  } catch(e) {
    res.json({ error: e.message, trades: [] });
  }
});

// ─── Polymarket PTB Proxy ───
app.get('/api/polymarket-ptb', async (req, res) => {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 300);
    
    for (const ts of [windowTs, windowTs - 300]) {
      const slug = 'btc-updown-5m-' + ts;
      
      try {
        const resp = await fetch('https://gamma-api.polymarket.com/events?slug=' + slug);
        if (!resp.ok) continue;
        const data = await resp.json();
        if (!data || !data.length) continue;
        
        const evt = data[0];
        const mkt = evt.markets && evt.markets[0];
        
        // Return ALL fields so we can find PTB
        return res.json({
          slug,
          timestamp: ts,
          eventTitle: evt.title,
          eventDescription: evt.description,
          marketQuestion: mkt?.question,
          marketDescription: mkt?.description,
          startPrice: mkt?.startPrice,
          endPrice: mkt?.endPrice,
          outcomePrices: mkt?.outcomePrices,
          outcomes: mkt?.outcomes,
          // Dump every field name and value
          allMarketFields: mkt ? Object.fromEntries(
            Object.entries(mkt).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? v.substring(0, 200) + '...' : v])
          ) : null,
          allEventFields: Object.fromEntries(
            Object.entries(evt).filter(([k]) => k !== 'markets').map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? v.substring(0, 200) + '...' : v])
          )
        });
      } catch(ex) { continue; }
    }
    
    res.json({ ptb: null, error: 'No market found' });
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
