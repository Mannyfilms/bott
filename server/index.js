const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const readline = require('readline');
const { verifyCode, isSessionValid, recordPrediction, resolvePrediction, getWinRate, getUnresolvedPredictions, saveState, loadState } = require('./database.js');

// Start Discord bot
require('../bot/index.js');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.API_SECRET || 'change-this-to-a-random-string';

// Warn loudly if running with the insecure default secret
if (SECRET === 'change-this-to-a-random-string') {
  console.warn('⚠️  WARNING: API_SECRET is using the insecure default value. Set the API_SECRET environment variable before going to production.');
}

app.use(express.json());
app.use(cookieParser());

// ─── Rate limiter for /api/verify (max 10 attempts per IP per 15 min) ───
const _verifyAttempts = new Map();
function checkVerifyRateLimit(ip) {
  const now = Date.now();
  const WINDOW = 15 * 60 * 1000;
  const MAX = 10;
  let entry = _verifyAttempts.get(ip);
  if (!entry || now > entry.resetAt) entry = { count: 0, resetAt: now + WINDOW };
  entry.count++;
  _verifyAttempts.set(ip, entry);
  return entry.count <= MAX;
}
// Clean up stale rate limit entries every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _verifyAttempts) if (now > v.resetAt) _verifyAttempts.delete(k);
}, 30 * 60 * 1000);

// ─── Auth Middleware ───
function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, SECRET);
    if (!payload.sessionToken || !payload.discordId) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
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

app.post('/api/verify', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkVerifyRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const user = verifyCode(code);
  if (!user) return res.status(403).json({ error: 'Invalid or revoked code' });

  const token = jwt.sign(
    { discordId: user.discord_id, username: user.discord_username, sessionToken: user.session_token },
    SECRET,
    { expiresIn: '7d' }
  );
  res.cookie('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
  return res.json({ success: true, username: user.discord_username });
});

app.get('/api/me', requireAuth, (req, res) => {
  return res.json({ authenticated: true, username: req.user.username });
});

// ─── Server-side PTB storage ───
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

// ═══ HOURLY PTB (public — free tier) ═══
// Restored from DB on startup
let serverHourlyPtb = loadState('hourlyPtb') || { price: null, hour: -1, timestamp: 0 };
if (serverHourlyPtb.hour !== new Date().getUTCHours()) serverHourlyPtb = { price: null, hour: -1, timestamp: 0 };
if (serverHourlyPtb.price) console.log('📌 Restored hourly PTB from DB: $' + serverHourlyPtb.price.toFixed(2));

app.post('/api/ptb-hourly', (req, res) => {
  const { price, hour } = req.body;
  if (price && price > 30000 && price < 200000 && hour >= 0 && hour <= 23) {
    const currentHour = new Date().getUTCHours();
    if (hour === currentHour) {
      serverHourlyPtb = { price, hour, timestamp: Date.now() };
      saveState('hourlyPtb', serverHourlyPtb);
      console.log('📌 Hourly PTB saved: $' + price.toFixed(2) + ' for hour ' + hour);
    }
  }
  res.json({ ok: true });
});

app.get('/api/ptb-hourly', (req, res) => {
  const currentHour = new Date().getUTCHours();
  if (serverHourlyPtb.price && serverHourlyPtb.hour === currentHour && (Date.now() - serverHourlyPtb.timestamp) < 3600000) {
    return res.json({ price: serverHourlyPtb.price, hour: serverHourlyPtb.hour });
  }
  res.json({ price: null });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  return res.json({ success: true });
});

// ═══ 5-MIN PREDICTION LOCK (auth required — for win rate tracking) ═══
app.post('/api/pred-lock-5m', requireAuth, (req, res) => {
  const { slotTs, direction, confidence } = req.body;
  if (!slotTs || !direction || !['UP','DOWN'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  recordPrediction('fivemin', slotTs, direction, confidence);
  res.json({ ok: true });
});

// ═══ HOURLY PREDICTION LOCK (public — free tier single source of truth) ═══
// Restored from DB on startup
let serverHourlyPredLock = loadState('hourlyPredLock') || { hour: -1, prediction: null, ts: 0 };
if (serverHourlyPredLock.hour !== new Date().getUTCHours()) serverHourlyPredLock = { hour: -1, prediction: null, ts: 0 };
if (serverHourlyPredLock.prediction) console.log('🔒 Restored hourly prediction lock from DB: ' + (serverHourlyPredLock.prediction.willBeat ? 'YES ↑' : 'NO ↓'));

app.post('/api/pred-lock-hourly', (req, res) => {
  const { hour, prediction, ts } = req.body;
  const currentHour = new Date().getUTCHours();
  if (hour === currentHour && prediction) {
    if (serverHourlyPredLock.hour !== currentHour) {
      serverHourlyPredLock = { hour, prediction, ts: ts || Date.now() };
      saveState('hourlyPredLock', serverHourlyPredLock);
      console.log('🔒 Hourly prediction locked (from client): ' + (prediction.willBeat ? 'YES' : 'NO') + ' (' + prediction.confidence + '%)');
      // Record in DB for win rate tracking
      const slotTs = Math.floor(Date.now() / 1000 / 3600) * 3600;
      const direction = prediction.willBeat ? 'UP' : 'DOWN';
      recordPrediction('hourly', slotTs, direction, prediction.confidence || 0);
    }
  }
  res.json({ ok: true });
});

app.get('/api/pred-lock-hourly', (req, res) => {
  const currentHour = new Date().getUTCHours();
  if (serverHourlyPredLock.hour === currentHour && serverHourlyPredLock.prediction) {
    return res.json(serverHourlyPredLock);
  }
  res.json({ hour: null, prediction: null });
});

// ─── Smart Whale Tracker ───
let topTradersCache = { wallets: [], lastDiscovery: 0 };
let whaleCache = { trades: null, lastFetch: 0 };

async function discoverTopTraders() {
  // Cache hit: 5 min if traders found, 60 s if none found (avoids log spam on every poll)
  const ttl = topTradersCache.wallets.length > 0 ? 300000 : 60000;
  if (Date.now() - topTradersCache.lastDiscovery < ttl) {
    return topTradersCache;
  }
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const traderStats = {};

    for (let i = 2; i <= 7; i++) {
      const slotTs = nowSec - (nowSec % 300) - (i * 300);
      const slug = 'btc-updown-5m-' + slotTs;
      try {
        const evtResp = await fetch('https://gamma-api.polymarket.com/events?slug=' + slug);
        if (!evtResp.ok) continue;
        const evtData = await evtResp.json();
        if (!evtData?.length || !evtData[0].markets?.[0]) continue;

        const mkt = evtData[0].markets[0];
        const conditionId = mkt.conditionId;
        const outcomes = JSON.parse(mkt.outcomes || '[]');
        const outcomePrices = JSON.parse(mkt.outcomePrices || '[]');

        let winner = null;
        outcomes.forEach((o, idx) => { if (parseFloat(outcomePrices[idx] || 0) > 0.9) winner = o; });
        if (!winner) continue;

        const holdersResp = await fetch('https://data-api.polymarket.com/holders?market=' + conditionId + '&limit=50&sizeThreshold=5');
        if (!holdersResp.ok) continue;
        const holders = await holdersResp.json();
        if (!Array.isArray(holders)) continue;

        holders.forEach(h => {
          const wallet = h.proxyWallet;
          if (!wallet) return;
          const wasRight = h.outcome === winner;
          const size = parseFloat(h.size || 0);
          if (size < 5) return;
          if (!traderStats[wallet]) traderStats[wallet] = { wins: 0, losses: 0, totalSize: 0, username: h.name || h.pseudonym || wallet.slice(0, 10) };
          if (wasRight) traderStats[wallet].wins++;
          else traderStats[wallet].losses++;
          traderStats[wallet].totalSize += size;
        });
      } catch(e) { continue; }
    }

    const ranked = Object.entries(traderStats)
      .filter(([_, s]) => s.wins + s.losses >= 3)
      .sort((a, b) => {
        const rateA = a[1].wins / (a[1].wins + a[1].losses);
        const rateB = b[1].wins / (b[1].wins + b[1].losses);
        if (rateB !== rateA) return rateB - rateA;
        return b[1].totalSize - a[1].totalSize;
      })
      .slice(0, 5)
      .map(([wallet, stats]) => ({
        wallet, username: stats.username,
        winRate: stats.wins / (stats.wins + stats.losses),
        wins: stats.wins, losses: stats.losses, totalSize: stats.totalSize
      }));

    if (ranked.length > 0) {
      topTradersCache = { wallets: ranked, lastDiscovery: Date.now() };
      console.log('🏆 Top traders: ' + ranked.map(t => t.username + ' (' + (t.winRate * 100).toFixed(0) + '%)').join(', '));
    } else {
      topTradersCache = { wallets: [], lastDiscovery: Date.now() }; // stamp so 60s TTL applies
      console.log('🔍 No qualifying traders found — will retry in 60s');
    }
    return topTradersCache;
  } catch(e) {
    console.log('Trader discovery error:', e.message);
    return topTradersCache;
  }
}

app.get('/api/whale-trades', async (req, res) => {
  try {
    if (whaleCache.trades && Date.now() - whaleCache.lastFetch < 10000) {
      return res.json(whaleCache.trades);
    }
    const topTraders = await discoverTopTraders();
    if (topTraders.wallets.length === 0) {
      const result = { whaleBet: null, topTrader: 'Discovering...', winRate: 0, totalTradesFound: 0 };
      whaleCache = { trades: result, lastFetch: Date.now() };
      return res.json(result);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const currentSlotTs = nowSec - (nowSec % 300);
    const currentSlug = 'btc-updown-5m-' + currentSlotTs;

    let currentConditionId = null;
    try {
      const evtResp = await fetch('https://gamma-api.polymarket.com/events?slug=' + currentSlug);
      if (evtResp.ok) {
        const evtData = await evtResp.json();
        if (evtData?.length && evtData[0].markets?.[0]) currentConditionId = evtData[0].markets[0].conditionId;
      }
    } catch(e) {}

    let yesVotes = 0, noVotes = 0, voterDetails = [];

    if (currentConditionId) {
      try {
        const holdersResp = await fetch('https://data-api.polymarket.com/holders?market=' + currentConditionId + '&limit=100');
        if (holdersResp.ok) {
          const holders = await holdersResp.json();
          if (Array.isArray(holders)) {
            const topWalletSet = new Set(topTraders.wallets.map(t => t.wallet));
            holders.forEach(h => {
              if (topWalletSet.has(h.proxyWallet)) {
                const trader = topTraders.wallets.find(t => t.wallet === h.proxyWallet);
                const size = parseFloat(h.size || 0);
                const direction = h.outcome === 'Up' ? 'YES' : 'NO';
                const weight = (trader.winRate || 0.5) * size;
                if (direction === 'YES') yesVotes += weight; else noVotes += weight;
                voterDetails.push({ username: trader.username, winRate: trader.winRate, direction, size, outcome: h.outcome });
              }
            });
          }
        }
      } catch(e) {}
    }

    for (const trader of topTraders.wallets.slice(0, 3)) {
      try {
        const resp = await fetch('https://data-api.polymarket.com/activity?address=' + trader.wallet + '&limit=5');
        if (!resp.ok) continue;
        const activity = await resp.json();
        const slotTrades = activity.filter(t => t.eventSlug === currentSlug && t.type === 'TRADE');
        slotTrades.forEach(t => {
          const direction = t.side === 'BUY' ? (t.outcome === 'Up' ? 'YES' : 'NO') : (t.outcome === 'Up' ? 'NO' : 'YES');
          const size = parseFloat(t.usdcSize || t.size || 0);
          const weight = (trader.winRate || 0.5) * size;
          if (!voterDetails.find(v => v.username === trader.username)) {
            if (direction === 'YES') yesVotes += weight; else noVotes += weight;
            voterDetails.push({ username: trader.username, winRate: trader.winRate, direction, size, outcome: t.outcome });
          }
        });
      } catch(e) { continue; }
    }

    const whaleBet = (yesVotes > 0 || noVotes > 0) ? (yesVotes > noVotes ? 'YES' : 'NO') : null;
    const bestTrader = topTraders.wallets[0];
    const result = {
      whaleBet, topTrader: bestTrader.username, winRate: bestTrader.winRate,
      topTraders: topTraders.wallets.map(t => ({ username: t.username, winRate: t.winRate, wins: t.wins, losses: t.losses })),
      voters: voterDetails, yesWeight: yesVotes, noWeight: noVotes,
      totalTradesFound: voterDetails.length,
      confidence: (yesVotes + noVotes) > 0 ? Math.abs(yesVotes - noVotes) / (yesVotes + noVotes) : 0
    };
    whaleCache = { trades: result, lastFetch: Date.now() };
    return res.json(result);
  } catch(e) {
    res.json({ error: e.message, trades: [] });
  }
});

// ─── Polymarket PTB Proxy (debug endpoint) ───
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
        return res.json({
          slug, timestamp: ts, eventTitle: evt.title,
          marketQuestion: mkt?.question,
          startPrice: mkt?.startPrice, endPrice: mkt?.endPrice,
          outcomePrices: mkt?.outcomePrices, outcomes: mkt?.outcomes,
          allMarketFields: mkt ? Object.fromEntries(
            Object.entries(mkt).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? v.substring(0, 200) + '...' : v])
          ) : null
        });
      } catch(ex) { continue; }
    }
    res.json({ ptb: null, error: 'No market found' });
  } catch (e) {
    res.json({ ptb: null, error: e.message });
  }
});

// ─── Recent Candle Results ───
let candleCache = { results: [], lastFetch: 0 };

app.get('/api/recent-candles', async (req, res) => {
  try {
    if (candleCache.results.length && Date.now() - candleCache.lastFetch < 60000) {
      return res.json({ candles: candleCache.results });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const results = [];
    for (let i = 2; i <= 11; i++) {
      const slotTs = nowSec - (nowSec % 300) - (i * 300);
      const slug = 'btc-updown-5m-' + slotTs;
      try {
        const resp = await fetch('https://gamma-api.polymarket.com/events?slug=' + slug);
        if (!resp.ok) continue;
        const data = await resp.json();
        if (!data?.length || !data[0].markets?.[0]) continue;
        const mkt = data[0].markets[0];
        const outcomes = JSON.parse(mkt.outcomes || '[]');
        const outcomePrices = JSON.parse(mkt.outcomePrices || '[]');
        let winner = null;
        outcomes.forEach((o, idx) => { if (parseFloat(outcomePrices[idx] || 0) > 0.9) winner = o; });
        if (winner) {
          results.push({
            slot: slotTs,
            result: winner.toLowerCase().includes('up') ? 'UP' : 'DOWN',
            time: new Date(slotTs * 1000).toISOString()
          });
        }
      } catch(e) { continue; }
    }
    candleCache = { results, lastFetch: Date.now() };
    res.json({ candles: results });
  } catch(e) {
    res.json({ candles: [], error: e.message });
  }
});

// ─── Polymarket Odds  ───
// FIX: use mkt.startPrice as the authoritative PTB — not regex parsing of description text.
// Polymarket's startPrice is the exact Chainlink BTC/USD price at the slot boundary.
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

          // ── PTB FIX: Use startPrice directly — authoritative source ──
          // Polymarket sets startPrice to the exact Chainlink BTC/USD at the slot boundary.
          // The old regex approach parsed description text and could pick up the wrong number.
          const ptb = mkt.startPrice ? parseFloat(mkt.startPrice) : null;

          const clobTokenIds = mkt.clobTokenIds ? JSON.parse(mkt.clobTokenIds) : [];
          return res.json({ upPrice, downPrice, ptb, slug, clobTokenIds, slotTs: ts });
        }
      } catch (ex) { continue; }
    }
    res.json({ upPrice: null, downPrice: null, ptb: null });
  } catch (e) {
    res.json({ upPrice: null, downPrice: null, error: e.message });
  }
});

// ═══ HOURLY PREDICTION LOCK (single source of truth) ═══
// Already declared above. Routes already registered.

// ═══ SERVER-SIDE AUTO-PREDICTION ═══

// Technical indicator functions
function serverSma(d, p) { if (d.length < p) return null; return d.slice(-p).reduce((a, b) => a + b, 0) / p; }
function serverEma(d, p) { if (d.length < p) return null; const k = 2 / (p + 1); let e = serverSma(d.slice(0, p), p); for (let i = p; i < d.length; i++) e = d[i] * k + e * (1 - k); return e; }
function serverRsi(d, p = 14) { if (d.length < p + 1) return null; const c = []; for (let i = 1; i < d.length; i++) c.push(d[i] - d[i - 1]); const r = c.slice(-p), g = r.filter(x => x > 0), l = r.filter(x => x < 0).map(Math.abs); const ag = g.length ? g.reduce((a, b) => a + b, 0) / p : 0, al = l.length ? l.reduce((a, b) => a + b, 0) / p : 0; if (!al) return 100; return 100 - 100 / (1 + ag / al); }
function serverMacd(d) { if (d.length < 26) return null; const m = serverEma(d, 12) - serverEma(d, 26); return { value: m, bullish: m > 0 }; }
function serverBb(d, p = 20) { if (d.length < p) return null; const s = serverSma(d, p), sl = d.slice(-p), v = sl.reduce((a, x) => a + Math.pow(x - s, 2), 0) / p, st = Math.sqrt(v); return { upper: s + st * 2, lower: s - st * 2, mid: s }; }

function serverEmaCrossover(prices) {
  if (prices.length < 25) return null;
  const e9 = serverEma(prices, 9), e21 = serverEma(prices, 21);
  const e9p = serverEma(prices.slice(0, -1), 9), e21p = serverEma(prices.slice(0, -1), 21);
  if (!e9 || !e21 || !e9p || !e21p) return null;
  return { crossUp: e9p <= e21p && e9 > e21, crossDown: e9p >= e21p && e9 < e21, bullish: e9 > e21 };
}

function serverStochRsi(prices, rp = 14, sp = 14) {
  if (prices.length < rp + sp) return null;
  const rs = [];
  for (let i = rp; i <= prices.length; i++) {
    const sl = prices.slice(i - rp - 1, i); let g = 0, l = 0;
    for (let j = 1; j < sl.length; j++) { const d = sl[j] - sl[j - 1]; if (d > 0) g += d; else l -= d; }
    rs.push(100 - (100 / (1 + g / Math.max(l, 0.001))));
  }
  if (rs.length < sp) return null;
  const rec = rs.slice(-sp), mn = Math.min(...rec), mx = Math.max(...rec);
  if (mx === mn) return { k: 50, signal: 'NEUTRAL' };
  const k = (rs[rs.length - 1] - mn) / (mx - mn) * 100;
  return { k, signal: k > 80 ? 'OVERBOUGHT' : k < 20 ? 'OVERSOLD' : k > 50 ? 'BULLISH' : 'BEARISH' };
}

function serverPriceVelocity(prices) {
  if (prices.length < 10) return null;
  const v1 = (prices[prices.length - 1] - prices[prices.length - 4]) / 3;
  const v2 = (prices[prices.length - 5] - prices[prices.length - 8]) / 3;
  const acc = v1 - v2;
  return {
    velocity: v1, acceleration: acc,
    signal: v1 > 0 && acc > 0 ? 'ACCELERATING UP' : v1 < 0 && acc < 0 ? 'ACCELERATING DOWN' :
      v1 > 0 && acc < 0 ? 'DECELERATING UP' : v1 < 0 && acc > 0 ? 'DECELERATING DOWN' : 'NEUTRAL'
  };
}

function serverVwap(candles) {
  if (!candles || candles.length < 5) return null;
  let cumVol = 0, cumPV = 0;
  candles.slice(-30).forEach(c => {
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * (c.volume || 1);
    cumVol += (c.volume || 1);
  });
  return cumVol ? cumPV / cumVol : null;
}

function serverAdx(closes, period = 14) {
  if (closes.length < period * 2) return null;
  let pDM = 0, nDM = 0, tr = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) pDM += diff; else nDM += Math.abs(diff);
    tr += Math.abs(diff);
  }
  if (tr === 0) return { adx: 0, trend: 'RANGING' };
  const pDI = pDM / tr * 100, nDI = nDM / tr * 100;
  const dx = Math.abs(pDI - nDI) / (pDI + nDI) * 100;
  return { adx: dx, pDI, nDI, trend: dx > 25 ? (pDI > nDI ? 'TRENDING_UP' : 'TRENDING_DOWN') : 'RANGING' };
}

// Volume confirmation: recent candles vs average volume
function serverVolumeSignal(candles) {
  if (!candles || candles.length < 10) return null;
  const avgVol = candles.slice(-20).reduce((s, c) => s + (c.volume || 1), 0) / Math.min(20, candles.length);
  const recentVol = candles.slice(-3).reduce((s, c) => s + (c.volume || 1), 0) / 3;
  const priceDir = candles[candles.length - 1].close > candles[candles.length - 4].close;
  const volRatio = recentVol / avgVol;
  return { volRatio, aboveAvg: volRatio > 1.2, bullish: priceDir && volRatio > 1.1, bearish: !priceDir && volRatio > 1.1 };
}

/**
 * Main server prediction function.
 * Now includes: Polymarket odds signal, volume confirmation, VWAP, regime-awareness.
 */
function serverMakePrediction(prices, ptbPrice, candles = [], polyOdds = null) {
  if (prices.length < 26) return null;

  let bullScore = 0, bearScore = 0;

  // 1. Momentum / Velocity
  const vel = serverPriceVelocity(prices);
  if (vel) {
    if (vel.signal === 'ACCELERATING UP') bullScore += 3;
    else if (vel.signal === 'DECELERATING UP') bullScore += 1;
    else if (vel.signal === 'ACCELERATING DOWN') bearScore += 3;
    else if (vel.signal === 'DECELERATING DOWN') bearScore += 1;
  }

  // 2. RSI
  const rs = serverRsi(prices);
  if (rs !== null) {
    if (rs < 30) bullScore += 2.5;
    else if (rs > 70) bearScore += 2.5;
    else if (rs < 45) bullScore += 1;
    else if (rs > 55) bearScore += 1;
  }

  // 3. EMA Crossover
  const ec = serverEmaCrossover(prices);
  if (ec) {
    if (ec.crossUp) bullScore += 3;
    else if (ec.crossDown) bearScore += 3;
    else if (ec.bullish) bullScore += 1.5;
    else bearScore += 1.5;
  }

  // 4. MACD
  const mc = serverMacd(prices);
  if (mc) { if (mc.bullish) bullScore += 1.5; else bearScore += 1.5; }

  // 5. Bollinger Bands
  const b = serverBb(prices);
  if (b) {
    const cur = prices[prices.length - 1];
    const pos = (cur - b.lower) / (b.upper - b.lower);
    if (pos < 0.15) bullScore += 2;
    else if (pos > 0.85) bearScore += 2;
  }

  // 6. Stoch RSI
  const sr = serverStochRsi(prices);
  if (sr) {
    if (sr.signal === 'OVERSOLD') bullScore += 2;
    else if (sr.signal === 'OVERBOUGHT') bearScore += 2;
  }

  // 7. PTB gap (mild signal)
  if (ptbPrice) {
    const cur = prices[prices.length - 1];
    const gap = Math.abs(cur - ptbPrice);
    if (gap > 200) { if (cur > ptbPrice) bullScore += 0.5; else bearScore += 0.5; }
  }

  // 8. ── Polymarket Odds (crowd wisdom — strongest external signal) ──
  // The market price is the aggregate prediction of traders betting real money.
  if (polyOdds && polyOdds.upPrice && polyOdds.downPrice) {
    const up = polyOdds.upPrice;
    if (up > 0.65) { bullScore += (up - 0.5) * 8; }       // strong market consensus up
    else if (up < 0.35) { bearScore += (0.5 - up) * 8; }  // strong market consensus down
    else if (up > 0.55) bullScore += 0.8;
    else if (up < 0.45) bearScore += 0.8;
  }

  // 9. ── Volume Confirmation ──
  const vs = serverVolumeSignal(candles);
  if (vs) {
    if (vs.bullish) bullScore += 1.2;
    else if (vs.bearish) bearScore += 1.2;
  }

  // 10. ── VWAP Position ──
  if (candles.length >= 10) {
    const vwapVal = serverVwap(candles);
    const cur = prices[prices.length - 1];
    if (vwapVal) {
      const vDev = (cur - vwapVal) / vwapVal * 100;
      if (vDev > 0.1) bullScore += 0.8;
      else if (vDev < -0.1) bearScore += 0.8;
    }
  }

  // 11. ── Regime: ADX trend strength ──
  const regime = serverAdx(prices);
  if (regime && regime.adx > 30) {
    // Strong trend — weight momentum signals more by boosting the existing score
    const boost = (regime.adx - 25) / 100;
    if (regime.trend === 'TRENDING_UP') bullScore *= (1 + boost);
    else if (regime.trend === 'TRENDING_DOWN') bearScore *= (1 + boost);
  }

  const total = bullScore + bearScore || 1;
  const bullPct = bullScore / total;
  const prediction = bullPct > 0.5;
  const margin = Math.abs(bullPct - 0.5) * 2;
  const confidence = Math.round(Math.max(50, Math.min(88, 52 + margin * 36)));

  return { willBeat: prediction, confidence, bullScore, bearScore, margin };
}

// Binance mirror endpoints — Railway (US) blocks api.binance.com with HTTP 451
const BINANCE_HOSTS = [
  'api.binance.com',
  'api1.binance.com',
  'api2.binance.com',
  'api3.binance.com',
  'api4.binance.com'
];

async function binanceFetch(path) {
  for (const host of BINANCE_HOSTS) {
    try {
      const resp = await fetch('https://' + host + path);
      if (resp.status === 451) continue; // geo-blocked, try next mirror
      return resp;
    } catch(e) {
      // network error, try next mirror
    }
  }
  return null;
}

// Fetch Binance klines with volumes — falls back to Bybit if all Binance mirrors are blocked
async function fetchServerKlines() {
  const now = new Date();
  const hourStart = new Date(now); hourStart.setMinutes(0, 0, 0);
  const startMs = hourStart.getTime();

  // 1) Try Binance mirrors
  try {
    const resp = await binanceFetch('/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=' + startMs + '&limit=60');
    if (resp && resp.ok) {
      const klines = await resp.json();
      const candles = klines.filter(k => k[0] >= startMs).map(k => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
      }));
      return { closes: candles.map(c => c.close), candles };
    }
  } catch(e) {}

  // 2) Bybit fallback — list is descending, reverse to ascending
  try {
    const resp = await fetch('https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=1&start=' + startMs + '&limit=60');
    if (!resp.ok) throw new Error('Bybit HTTP ' + resp.status);
    const json = await resp.json();
    if (json.retCode !== 0) throw new Error('Bybit error ' + json.retCode);
    const list = (json.result?.list || []).slice().reverse(); // ascending order
    const candles = list.filter(k => parseInt(k[0]) >= startMs).map(k => ({
      time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
    }));
    console.log('📡 Kline source: Bybit (' + candles.length + ' candles)');
    return { closes: candles.map(c => c.close), candles };
  } catch(e) {
    console.warn('⚠️ Server kline fetch failed (all sources):', e.message);
    return null;
  }
}

// Fetch current Polymarket odds (for server-side signal)
let _cachedPolyOdds = null;
let _polyOddsLastFetch = 0;
async function fetchCurrentPolyOdds() {
  if (_cachedPolyOdds && Date.now() - _polyOddsLastFetch < 30000) return _cachedPolyOdds;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 300);
    for (const ts of [windowTs, windowTs - 300]) {
      const slug = 'btc-updown-5m-' + ts;
      const resp = await fetch('https://gamma-api.polymarket.com/events?slug=' + slug);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data?.length && data[0].markets?.[0]) {
        const mkt = data[0].markets[0];
        const prices = JSON.parse(mkt.outcomePrices || '[]');
        const outcomes = JSON.parse(mkt.outcomes || '[]');
        let upPrice = null, downPrice = null;
        outcomes.forEach((o, i) => {
          if (o.toLowerCase().includes('up')) upPrice = parseFloat(prices[i]);
          if (o.toLowerCase().includes('down')) downPrice = parseFloat(prices[i]);
        });
        if (upPrice) {
          _cachedPolyOdds = { upPrice, downPrice };
          _polyOddsLastFetch = Date.now();
          return _cachedPolyOdds;
        }
      }
    }
  } catch(e) {}
  return _cachedPolyOdds;
}

// Auto-prediction: runs every 60s
async function runAutoPrediction() {
  const currentHour = new Date().getUTCHours();

  if (serverHourlyPredLock.hour === currentHour && serverHourlyPredLock.prediction) return;

  const klines = await fetchServerKlines();
  if (!klines || klines.closes.length < 26) {
    console.log('⏳ Auto-prediction: only ' + ((klines && klines.closes.length) || 0) + ' candles, need 26. Will retry.');
    return;
  }

  const { closes: prices, candles } = klines;

  // Get or set PTB
  let ptbPrice = serverHourlyPtb.hour === currentHour ? serverHourlyPtb.price : null;
  if (!ptbPrice) {
    let openPrice = null;
    // Try Binance mirrors
    try {
      const resp = await binanceFetch('/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1');
      if (resp && resp.ok) {
        const d = await resp.json();
        if (d && d[0]) openPrice = parseFloat(d[0][1]);
      }
    } catch(e) {}
    // Bybit fallback
    if (!openPrice) {
      try {
        const resp = await fetch('https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=60&limit=1');
        if (resp.ok) {
          const json = await resp.json();
          if (json.retCode === 0 && json.result?.list?.length) openPrice = parseFloat(json.result.list[0][1]);
        }
      } catch(e) {}
    }
    if (openPrice && openPrice > 30000 && openPrice < 200000) {
      serverHourlyPtb = { price: openPrice, hour: currentHour, timestamp: Date.now() };
      saveState('hourlyPtb', serverHourlyPtb);
      ptbPrice = openPrice;
      console.log('📌 Auto-set hourly PTB: $' + openPrice.toFixed(2));
    }
  }

  // Fetch Polymarket odds for the signal
  const polyOdds = await fetchCurrentPolyOdds();

  const result = serverMakePrediction(prices, ptbPrice, candles, polyOdds);
  if (!result) return;

  // Dynamic lock timing
  const minutesIn = new Date().getMinutes();
  const priceDiff = ptbPrice ? Math.abs(prices[prices.length - 1] - ptbPrice) : 999;
  const MIN_WAIT = 2, MAX_WAIT = 15, CLOSE = 30, CLEAR = 150;
  let lockAfter;
  if (priceDiff >= CLEAR) lockAfter = MIN_WAIT;
  else if (priceDiff <= CLOSE) lockAfter = MAX_WAIT;
  else { const t = (priceDiff - CLOSE) / (CLEAR - CLOSE); lockAfter = MAX_WAIT - t * (MAX_WAIT - MIN_WAIT); }
  if (result.margin > 0.5) lockAfter = Math.max(MIN_WAIT, lockAfter - result.margin * 3);

  if (minutesIn >= lockAfter) {
    const slotTs = Math.floor(Date.now() / 1000 / 3600) * 3600; // current hour in unix seconds
    const direction = result.willBeat ? 'UP' : 'DOWN';

    serverHourlyPredLock = {
      hour: currentHour,
      prediction: { willBeat: result.willBeat, confidence: result.confidence, bullScore: result.bullScore, bearScore: result.bearScore },
      ts: Date.now()
    };
    saveState('hourlyPredLock', serverHourlyPredLock);

    // Record in DB for win rate tracking
    recordPrediction('hourly', slotTs, direction, result.confidence);

    console.log('🔒 Auto-prediction locked: ' + (result.willBeat ? 'YES ↑' : 'NO ↓') + ' (' + result.confidence + '%) at minute ' + minutesIn + ' | gap $' + priceDiff.toFixed(0));
  } else {
    console.log('⏳ Auto-prediction: leaning ' + (result.willBeat ? 'YES' : 'NO') + ' but waiting (minute ' + minutesIn + '/' + Math.ceil(lockAfter) + ')');
  }
}

// Run auto-prediction every 60 seconds
setInterval(runAutoPrediction, 60000);
setTimeout(runAutoPrediction, 5000);

// ─── Hourly reset: calculate exact ms to next hour boundary instead of busy-loop ───
function scheduleHourlyReset() {
  const now = new Date();
  const msToNextHour = (60 - now.getMinutes()) * 60000 - now.getSeconds() * 1000 - now.getMilliseconds();
  setTimeout(() => {
    // Check hourly outcome BEFORE clearing the lock
    checkHourlyOutcome();

    serverHourlyPredLock = { hour: -1, prediction: null, ts: 0 };
    serverHourlyPtb = { price: null, hour: -1, timestamp: 0 };
    saveState('hourlyPredLock', serverHourlyPredLock);
    saveState('hourlyPtb', serverHourlyPtb);
    console.log('🔄 Hourly prediction reset at top of hour');
    scheduleHourlyReset(); // schedule next hour
  }, msToNextHour + 1000); // +1s buffer past the boundary
}
scheduleHourlyReset();

// ─── Outcome checkers ───

/**
 * Called just before the hourly reset. Fetches Binance to determine
 * if the final close beat the hourly open (PTB), then records win/loss.
 */
async function checkHourlyOutcome() {
  const lock = serverHourlyPredLock;
  if (!lock.prediction || lock.hour < 0) return;

  const slotTs = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const ptbPrice = serverHourlyPtb.price;
  if (!ptbPrice) return;

  try {
    // Fetch the closing price of the completed 1h candle
    let closePrice = null;
    const resp = await binanceFetch('/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2');
    if (resp && resp.ok) {
      const data = await resp.json();
      if (data && data.length >= 1) closePrice = parseFloat(data[0][4]);
    }
    // Bybit fallback — list is descending; list[1] = just-completed hourly candle
    if (!closePrice) {
      try {
        const bResp = await fetch('https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=60&limit=2');
        if (bResp.ok) {
          const bJson = await bResp.json();
          if (bJson.retCode === 0 && bJson.result?.list?.length >= 2) closePrice = parseFloat(bJson.result.list[1][4]);
        }
      } catch(e2) {}
    }
    if (!closePrice) return;
    const actualDirection = closePrice > ptbPrice ? 'UP' : 'DOWN';
    const updated = resolvePrediction('hourly', slotTs, actualDirection);
    if (updated) {
      const predicted = lock.prediction.willBeat ? 'UP' : 'DOWN';
      const correct = predicted === actualDirection;
      const wr = getWinRate('hourly');
      console.log('📊 Hourly outcome: predicted=' + predicted + ' actual=' + actualDirection + ' → ' + (correct ? '✅ CORRECT' : '❌ WRONG') + ' | 1H win rate: ' + wr.wins + 'W/' + wr.losses + 'L (' + (wr.rate || '--') + '%)');
    }
  } catch(e) {
    console.warn('⚠️ checkHourlyOutcome error:', e.message);
  }
}

/**
 * Checks resolved 5-min Polymarket markets for any pending predictions.
 * Runs every 6 minutes.
 */
async function check5minOutcomes() {
  const unresolved = getUnresolvedPredictions('fivemin', 370);
  if (!unresolved.length) return;

  for (const pred of unresolved) {
    const slug = 'btc-updown-5m-' + pred.slot_ts;
    try {
      const resp = await fetch('https://gamma-api.polymarket.com/events?slug=' + slug);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (!data?.length || !data[0].markets?.[0]) continue;
      const mkt = data[0].markets[0];
      const outcomes = JSON.parse(mkt.outcomes || '[]');
      const outcomePrices = JSON.parse(mkt.outcomePrices || '[]');
      let winner = null;
      outcomes.forEach((o, idx) => { if (parseFloat(outcomePrices[idx] || 0) > 0.9) winner = o; });
      if (!winner) continue;
      const actualDirection = winner.toLowerCase().includes('up') ? 'UP' : 'DOWN';
      const updated = resolvePrediction('fivemin', pred.slot_ts, actualDirection);
      if (updated) {
        const correct = pred.direction === actualDirection;
        const wr = getWinRate('fivemin');
        console.log('📊 5min outcome [' + slug + ']: predicted=' + pred.direction + ' actual=' + actualDirection + ' → ' + (correct ? '✅ CORRECT' : '❌ WRONG') + ' | 5M win rate: ' + wr.wins + 'W/' + wr.losses + 'L (' + (wr.rate || '--') + '%)');
      }
    } catch(e) { continue; }
  }
}

// Check 5-min outcomes every 6 minutes
setInterval(check5minOutcomes, 6 * 60 * 1000);
setTimeout(check5minOutcomes, 30000); // initial check on startup

// ─── Serve Frontend ───

app.get('/free', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'free.html'));
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
      if (payload.sessionToken && payload.discordId && isSessionValid(payload.discordId, payload.sessionToken)) {
        return res.redirect('/app');
      }
    } catch (e) { /* invalid token */ }
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Start Server ───
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
});

// ─────────────────────────────────────────────────────────
//  CONSOLE WIN RATE COMMAND
//  Type  winrate  in the terminal to see both win rates
//  Type  winrate reset  to clear all prediction data
// ─────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('line', (line) => {
  const cmd = line.trim().toLowerCase();
  if (cmd === 'winrate' || cmd === 'wr') {
    const h = getWinRate('hourly');
    const f = getWinRate('fivemin');

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║          PREDICTION WIN RATES             ║');
    console.log('╠══════════════════════════════════════════╣');

    console.log('║  1-Hour Predictor                         ║');
    console.log('║  Wins:   ' + String(h.wins).padEnd(6) + ' Losses: ' + String(h.losses).padEnd(6) + ' Total: ' + String(h.total).padEnd(6) + '║');
    console.log('║  Rate:   ' + (h.rate ? h.rate + '%' : 'N/A (no data)').padEnd(33) + '║');
    if (h.total > 0) {
      const streakStr = (h.streakWin ? '✅' : '❌') + ' ' + h.streak + 'x';
      console.log('║  Streak: ' + streakStr.padEnd(33) + '║');
      const bar = h.last10.map(r => r.correct ? '✅' : '❌').join(' ');
      console.log('║  Last 10: ' + bar.padEnd(32) + '║');
    }

    console.log('╠══════════════════════════════════════════╣');

    console.log('║  5-Minute Predictor                       ║');
    console.log('║  Wins:   ' + String(f.wins).padEnd(6) + ' Losses: ' + String(f.losses).padEnd(6) + ' Total: ' + String(f.total).padEnd(6) + '║');
    console.log('║  Rate:   ' + (f.rate ? f.rate + '%' : 'N/A (no data)').padEnd(33) + '║');
    if (f.total > 0) {
      const streakStr = (f.streakWin ? '✅' : '❌') + ' ' + f.streak + 'x';
      console.log('║  Streak: ' + streakStr.padEnd(33) + '║');
      const bar = f.last10.map(r => r.correct ? '✅' : '❌').join(' ');
      console.log('║  Last 10: ' + bar.padEnd(32) + '║');
    }

    console.log('╚══════════════════════════════════════════╝\n');
  } else if (cmd === 'help') {
    console.log('\nAvailable commands:');
    console.log('  winrate  (or wr) — show 1-hour and 5-min win rates');
    console.log('  help             — show this message\n');
  }
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});
