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

// ═══ HOURLY PTB (public — for free tier) ═══
let serverHourlyPtb = { price: null, hour: -1, timestamp: 0 };

app.post('/api/ptb-hourly', (req, res) => {
  const { price, hour } = req.body;
  if (price && price > 30000 && price < 200000 && hour >= 0 && hour <= 23) {
    const currentHour = new Date().getUTCHours();
    // Only accept if it's for the current hour
    if (hour === currentHour) {
      serverHourlyPtb = { price, hour, timestamp: Date.now() };
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

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  return res.json({ success: true });
});

// ─── Smart Whale Tracker: Find & follow best BTC 5-min traders using public APIs ───
let topTradersCache = { wallets: [], lastDiscovery: 0 }; // wallet -> {wins, username}
let whaleCache = { trades: null, lastFetch: 0 };

// Discover top performers from recently resolved BTC 5-min markets
async function discoverTopTraders() {
  // Rediscover every 5 minutes
  if (topTradersCache.wallets.length > 0 && Date.now() - topTradersCache.lastDiscovery < 300000) {
    return topTradersCache;
  }
  
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const traderStats = {}; // wallet -> {wins, losses, username}
    
    // Look at last 6 resolved BTC 5-min markets
    for (let i = 2; i <= 7; i++) {
      const slotTs = nowSec - (nowSec % 300) - (i * 300);
      const slug = 'btc-updown-5m-' + slotTs;
      
      try {
        // Get market info from Gamma
        const evtResp = await fetch('https://gamma-api.polymarket.com/events?slug=' + slug);
        if (!evtResp.ok) continue;
        const evtData = await evtResp.json();
        if (!evtData?.length || !evtData[0].markets?.[0]) continue;
        
        const mkt = evtData[0].markets[0];
        const conditionId = mkt.conditionId;
        const outcomes = JSON.parse(mkt.outcomes || '[]');
        const outcomePrices = JSON.parse(mkt.outcomePrices || '[]');
        
        // Determine winner (resolved market has one outcome near $1)
        let winner = null;
        outcomes.forEach((o, idx) => {
          if (parseFloat(outcomePrices[idx] || 0) > 0.9) winner = o;
        });
        if (!winner) continue;
        
        // Use /holders to see who held positions in this market
        const holdersResp = await fetch('https://data-api.polymarket.com/holders?market=' + conditionId + '&limit=50&sizeThreshold=5');
        if (!holdersResp.ok) continue;
        const holders = await holdersResp.json();
        if (!Array.isArray(holders)) continue;
        
        holders.forEach(h => {
          const wallet = h.proxyWallet;
          if (!wallet) return;
          
          // Did they hold the winning outcome?
          const wasRight = h.outcome === winner;
          const size = parseFloat(h.size || 0);
          if (size < 5) return; // Skip tiny positions
          
          if (!traderStats[wallet]) traderStats[wallet] = { wins: 0, losses: 0, totalSize: 0, username: h.name || h.pseudonym || wallet.slice(0,10) };
          if (wasRight) traderStats[wallet].wins++;
          else traderStats[wallet].losses++;
          traderStats[wallet].totalSize += size;
        });
      } catch(e) { continue; }
    }
    
    // Rank traders: best win rate with minimum 3 markets
    const ranked = Object.entries(traderStats)
      .filter(([_, s]) => s.wins + s.losses >= 3)
      .sort((a, b) => {
        const rateA = a[1].wins / (a[1].wins + a[1].losses);
        const rateB = b[1].wins / (b[1].wins + b[1].losses);
        if (rateB !== rateA) return rateB - rateA;
        return b[1].totalSize - a[1].totalSize; // Tiebreak by volume
      })
      .slice(0, 5) // Top 5 traders
      .map(([wallet, stats]) => ({
        wallet,
        username: stats.username,
        winRate: stats.wins / (stats.wins + stats.losses),
        wins: stats.wins,
        losses: stats.losses,
        totalSize: stats.totalSize
      }));
    
    if (ranked.length > 0) {
      topTradersCache = { wallets: ranked, lastDiscovery: Date.now() };
      console.log('🏆 Top traders discovered: ' + ranked.map(t => t.username + ' (' + (t.winRate * 100).toFixed(0) + '%)').join(', '));
    } else {
      console.log('🔍 No qualifying traders found yet (need 3+ markets)');
    }
    
    return topTradersCache;
  } catch(e) {
    console.log('Trader discovery error:', e.message);
    return topTradersCache;
  }
}

app.get('/api/whale-trades', async (req, res) => {
  try {
    // Cache for 10 seconds
    if (whaleCache.trades && Date.now() - whaleCache.lastFetch < 10000) {
      return res.json(whaleCache.trades);
    }
    
    // Find top traders
    const topTraders = await discoverTopTraders();
    
    if (topTraders.wallets.length === 0) {
      const result = { whaleBet: null, topTrader: 'Discovering...', winRate: 0, totalTradesFound: 0 };
      whaleCache = { trades: result, lastFetch: Date.now() };
      return res.json(result);
    }
    
    // Get current market's conditionId
    const nowSec = Math.floor(Date.now() / 1000);
    const currentSlotTs = nowSec - (nowSec % 300);
    const currentSlug = 'btc-updown-5m-' + currentSlotTs;
    
    let currentConditionId = null;
    try {
      const evtResp = await fetch('https://gamma-api.polymarket.com/events?slug=' + currentSlug);
      if (evtResp.ok) {
        const evtData = await evtResp.json();
        if (evtData?.length && evtData[0].markets?.[0]) {
          currentConditionId = evtData[0].markets[0].conditionId;
        }
      }
    } catch(e) {}
    
    let yesVotes = 0, noVotes = 0;
    let voterDetails = [];
    
    if (currentConditionId) {
      // Check current market holders to see if any top traders have positions
      try {
        const holdersResp = await fetch('https://data-api.polymarket.com/holders?market=' + currentConditionId + '&limit=100');
        if (holdersResp.ok) {
          const holders = await holdersResp.json();
          if (Array.isArray(holders)) {
            // Match holders against our top traders
            const topWalletSet = new Set(topTraders.wallets.map(t => t.wallet));
            
            holders.forEach(h => {
              if (topWalletSet.has(h.proxyWallet)) {
                const trader = topTraders.wallets.find(t => t.wallet === h.proxyWallet);
                const size = parseFloat(h.size || 0);
                const direction = h.outcome === 'Up' ? 'YES' : 'NO';
                // Weight by win rate and position size
                const weight = (trader.winRate || 0.5) * size;
                
                if (direction === 'YES') yesVotes += weight;
                else noVotes += weight;
                
                voterDetails.push({
                  username: trader.username,
                  winRate: trader.winRate,
                  direction,
                  size,
                  outcome: h.outcome
                });
              }
            });
          }
        }
      } catch(e) {}
    }
    
    // Also check via /activity for top traders who traded this slot
    // (catches trades that /holders might not show yet)
    for (const trader of topTraders.wallets.slice(0, 3)) { // Top 3 only to limit API calls
      try {
        const resp = await fetch('https://data-api.polymarket.com/activity?address=' + trader.wallet + '&limit=5');
        if (!resp.ok) continue;
        const activity = await resp.json();
        
        const slotTrades = activity.filter(t => t.eventSlug === currentSlug && t.type === 'TRADE');
        slotTrades.forEach(t => {
          const direction = t.side === 'BUY'
            ? (t.outcome === 'Up' ? 'YES' : 'NO')
            : (t.outcome === 'Up' ? 'NO' : 'YES');
          const size = parseFloat(t.usdcSize || t.size || 0);
          const weight = (trader.winRate || 0.5) * size;
          
          // Only add if not already counted from /holders
          if (!voterDetails.find(v => v.username === trader.username)) {
            if (direction === 'YES') yesVotes += weight;
            else noVotes += weight;
            
            voterDetails.push({
              username: trader.username,
              winRate: trader.winRate,
              direction,
              size,
              outcome: t.outcome
            });
          }
        });
      } catch(e) { continue; }
    }
    
    const whaleBet = (yesVotes > 0 || noVotes > 0) ? (yesVotes > noVotes ? 'YES' : 'NO') : null;
    const bestTrader = topTraders.wallets[0];
    
    const result = {
      whaleBet,
      topTrader: bestTrader.username,
      winRate: bestTrader.winRate,
      topTraders: topTraders.wallets.map(t => ({ username: t.username, winRate: t.winRate, wins: t.wins, losses: t.losses })),
      voters: voterDetails,
      yesWeight: yesVotes,
      noWeight: noVotes,
      totalTradesFound: voterDetails.length,
      confidence: (yesVotes + noVotes) > 0 ? Math.abs(yesVotes - noVotes) / (yesVotes + noVotes) : 0
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

// ─── Recent Candle Results (last 10 resolved 5-min markets) ───
let candleCache = { results: [], lastFetch: 0 };

app.get('/api/recent-candles', async (req, res) => {
  try {
    // Cache for 60 seconds
    if (candleCache.results.length && Date.now() - candleCache.lastFetch < 60000) {
      return res.json({ candles: candleCache.results });
    }
    
    const nowSec = Math.floor(Date.now() / 1000);
    const results = [];
    
    // Check last 10 resolved 5-min slots
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
        outcomes.forEach((o, idx) => {
          if (parseFloat(outcomePrices[idx] || 0) > 0.9) winner = o;
        });
        
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
          
          // Include token IDs for orderbook WebSocket
          const clobTokenIds = mkt.clobTokenIds ? JSON.parse(mkt.clobTokenIds) : [];
          
          return res.json({ upPrice, downPrice, ptb, slug, clobTokenIds });
        }
      } catch (ex) { continue; }
    }
    res.json({ upPrice: null, downPrice: null, ptb: null });
  } catch (e) {
    res.json({ upPrice: null, downPrice: null, error: e.message });
  }
});

// ═══ HOURLY PREDICTION LOCK (public — for free tier) ═══
// Single source of truth: first prediction to lock sets it for ALL users.
let serverHourlyPredLock = { hour: -1, prediction: null, ts: 0 };

app.post('/api/pred-lock-hourly', (req, res) => {
  const { hour, prediction, ts } = req.body;
  const currentHour = new Date().getUTCHours();
  if (hour === currentHour && prediction) {
    // Only accept if no prediction is locked yet for this hour
    if (serverHourlyPredLock.hour !== currentHour) {
      serverHourlyPredLock = { hour, prediction, ts: ts || Date.now() };
      console.log('🔒 Hourly prediction locked: ' + (prediction.willBeat ? 'YES' : 'NO') + ' (' + prediction.confidence + '%)');
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

// ═══ SERVER-SIDE AUTO-PREDICTION (runs every hour, no visitors needed) ═══
// Fetches Binance 1m klines server-side (no CORS issues), runs the same
// technical indicators as the frontend, and locks the prediction automatically.

// -- Technical indicator functions (mirrors frontend exactly) --
function serverSma(d,p){if(d.length<p)return null;return d.slice(-p).reduce((a,b)=>a+b,0)/p}
function serverEma(d,p){if(d.length<p)return null;const k=2/(p+1);let e=serverSma(d.slice(0,p),p);for(let i=p;i<d.length;i++)e=d[i]*k+e*(1-k);return e}
function serverRsi(d,p=14){if(d.length<p+1)return null;const c=[];for(let i=1;i<d.length;i++)c.push(d[i]-d[i-1]);const r=c.slice(-p),g=r.filter(x=>x>0),l=r.filter(x=>x<0).map(Math.abs);const ag=g.length?g.reduce((a,b)=>a+b,0)/p:0,al=l.length?l.reduce((a,b)=>a+b,0)/p:0;if(!al)return 100;return 100-100/(1+ag/al)}
function serverMacd(d){if(d.length<26)return null;const m=serverEma(d,12)-serverEma(d,26);return{value:m,bullish:m>0}}
function serverBb(d,p=20){if(d.length<p)return null;const s=serverSma(d,p),sl=d.slice(-p),v=sl.reduce((a,x)=>a+Math.pow(x-s,2),0)/p,st=Math.sqrt(v);return{upper:s+st*2,lower:s-st*2,mid:s}}

function serverEmaCrossover(prices){
  if(prices.length<25)return null;
  const e9=serverEma(prices,9),e21=serverEma(prices,21);
  const e9p=serverEma(prices.slice(0,-1),9),e21p=serverEma(prices.slice(0,-1),21);
  if(!e9||!e21||!e9p||!e21p)return null;
  return{crossUp:e9p<=e21p&&e9>e21,crossDown:e9p>=e21p&&e9<e21,bullish:e9>e21}
}

function serverStochRsi(prices,rp=14,sp=14){
  if(prices.length<rp+sp)return null;
  const rs=[];
  for(let i=rp;i<=prices.length;i++){
    const sl=prices.slice(i-rp-1,i);let g=0,l=0;
    for(let j=1;j<sl.length;j++){const d=sl[j]-sl[j-1];if(d>0)g+=d;else l-=d}
    rs.push(100-(100/(1+g/Math.max(l,0.001))));
  }
  if(rs.length<sp)return null;
  const rec=rs.slice(-sp),mn=Math.min(...rec),mx=Math.max(...rec);
  if(mx===mn)return{k:50,signal:'NEUTRAL'};
  const k=(rs[rs.length-1]-mn)/(mx-mn)*100;
  return{k,signal:k>80?'OVERBOUGHT':k<20?'OVERSOLD':k>50?'BULLISH':'BEARISH'}
}

function serverPriceVelocity(prices){
  if(prices.length<10)return null;
  const v1=(prices[prices.length-1]-prices[prices.length-4])/3;
  const v2=(prices[prices.length-5]-prices[prices.length-8])/3;
  const acc=v1-v2;
  return{velocity:v1,acceleration:acc,
    signal:v1>0&&acc>0?'ACCELERATING UP':v1<0&&acc<0?'ACCELERATING DOWN':
           v1>0&&acc<0?'DECELERATING UP':v1<0&&acc>0?'DECELERATING DOWN':'NEUTRAL'}
}

function serverMakePrediction(prices, ptbPrice){
  if(prices.length<26)return null;

  let bullScore=0,bearScore=0;

  // 1. Momentum
  const vel=serverPriceVelocity(prices);
  if(vel){
    if(vel.signal==='ACCELERATING UP')bullScore+=3;
    else if(vel.signal==='DECELERATING UP')bullScore+=1;
    else if(vel.signal==='ACCELERATING DOWN')bearScore+=3;
    else if(vel.signal==='DECELERATING DOWN')bearScore+=1;
  }

  // 2. RSI
  const rs=serverRsi(prices);
  if(rs!==null){
    if(rs<30)bullScore+=2.5;
    else if(rs>70)bearScore+=2.5;
    else if(rs<45)bullScore+=1;
    else if(rs>55)bearScore+=1;
  }

  // 3. EMA crossover
  const ec=serverEmaCrossover(prices);
  if(ec){
    if(ec.crossUp)bullScore+=3;
    else if(ec.crossDown)bearScore+=3;
    else if(ec.bullish)bullScore+=1.5;
    else bearScore+=1.5;
  }

  // 4. MACD
  const mc=serverMacd(prices);
  if(mc){
    if(mc.bullish)bullScore+=1.5;
    else bearScore+=1.5;
  }

  // 5. Bollinger Bands
  const b=serverBb(prices);
  if(b){
    const cur=prices[prices.length-1];
    const pos=(cur-b.lower)/(b.upper-b.lower);
    if(pos<0.15)bullScore+=2;
    else if(pos>0.85)bearScore+=2;
  }

  // 6. Stoch RSI
  const sr=serverStochRsi(prices);
  if(sr){
    if(sr.signal==='OVERSOLD')bullScore+=2;
    else if(sr.signal==='OVERBOUGHT')bearScore+=2;
  }

  // 7. Price vs PTB (mild signal for large gaps)
  if(ptbPrice){
    const cur=prices[prices.length-1];
    const gap=Math.abs(cur-ptbPrice);
    if(gap>200){
      if(cur>ptbPrice)bullScore+=0.5;
      else bearScore+=0.5;
    }
  }

  const total=bullScore+bearScore||1;
  const bullPct=bullScore/total;
  const prediction=bullPct>0.5;
  const margin=Math.abs(bullPct-0.5)*2;
  const confidence=Math.round(Math.max(50,Math.min(88,52+margin*36)));

  return{willBeat:prediction,confidence,bullScore,bearScore,margin};
}

// -- Fetch Binance klines server-side (no CORS) --
async function fetchServerKlines(){
  try{
    const now=new Date();
    const hourStart=new Date(now);hourStart.setMinutes(0,0,0);
    const startMs=hourStart.getTime();
    const resp=await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime='+startMs+'&limit=60');
    if(!resp.ok)throw new Error('HTTP '+resp.status);
    const klines=await resp.json();
    return klines.filter(k=>k[0]>=startMs).map(k=>parseFloat(k[4])); // close prices
  }catch(e){
    console.warn('⚠️ Server kline fetch failed:',e.message);
    return null;
  }
}

// -- Auto-prediction cron: runs at fixed intervals each hour --
async function runAutoPrediction(){
  const currentHour=new Date().getUTCHours();
  
  // Already locked this hour? Skip.
  if(serverHourlyPredLock.hour===currentHour&&serverHourlyPredLock.prediction){
    return;
  }

  const prices=await fetchServerKlines();
  if(!prices||prices.length<26){
    console.log('⏳ Auto-prediction: only '+((prices&&prices.length)||0)+' candles, need 26. Will retry.');
    return;
  }

  // Get PTB
  const ptbPrice=serverHourlyPtb.hour===currentHour?serverHourlyPtb.price:null;
  
  // If we don't have PTB yet, set it from the first candle's open
  if(!ptbPrice){
    try{
      const resp=await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1');
      if(resp.ok){
        const d=await resp.json();
        if(d&&d[0]){
          const openPrice=parseFloat(d[0][1]);
          if(openPrice>30000&&openPrice<200000){
            serverHourlyPtb={price:openPrice,hour:currentHour,timestamp:Date.now()};
            console.log('📌 Auto-set hourly PTB: $'+openPrice.toFixed(2));
          }
        }
      }
    }catch(e){}
  }

  const result=serverMakePrediction(prices, serverHourlyPtb.price);
  if(!result)return;

  // Check lock timing (same logic as frontend)
  const minutesIn=new Date().getMinutes();
  const priceDiff=serverHourlyPtb.price?Math.abs(prices[prices.length-1]-serverHourlyPtb.price):999;
  const MIN_WAIT=2,MAX_WAIT=15,CLOSE=30,CLEAR=150;
  let lockAfter;
  if(priceDiff>=CLEAR)lockAfter=MIN_WAIT;
  else if(priceDiff<=CLOSE)lockAfter=MAX_WAIT;
  else{const t=(priceDiff-CLOSE)/(CLEAR-CLOSE);lockAfter=MAX_WAIT-t*(MAX_WAIT-MIN_WAIT)}
  if(result.margin>0.5)lockAfter=Math.max(MIN_WAIT,lockAfter-result.margin*3);

  if(minutesIn>=lockAfter){
    serverHourlyPredLock={
      hour:currentHour,
      prediction:{willBeat:result.willBeat,confidence:result.confidence,bullScore:result.bullScore,bearScore:result.bearScore},
      ts:Date.now()
    };
    console.log('🔒 Auto-prediction locked: '+(result.willBeat?'YES ↑':'NO ↓')+' ('+result.confidence+'%) at minute '+minutesIn+' | gap $'+priceDiff.toFixed(0));
  } else {
    console.log('⏳ Auto-prediction: leaning '+(result.willBeat?'YES':'NO')+' but waiting (minute '+minutesIn+'/'+Math.ceil(lockAfter)+')');
  }
}

// Run auto-prediction every 60 seconds
setInterval(runAutoPrediction,60000);
// Also run once on server start (after a short delay for PTB to load)
setTimeout(runAutoPrediction,5000);

// Reset prediction lock at the top of each hour
setInterval(()=>{
  const now=new Date();
  if(now.getMinutes()===0&&now.getSeconds()<5){
    serverHourlyPredLock={hour:-1,prediction:null,ts:0};
    console.log('🔄 Hourly prediction reset');
  }
},1000);

// ─── Serve Frontend ───

// Free tier page (1-hour predictor, no auth needed) - MUST be before static
app.get('/free', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'free.html'));
});

// Protected app page (5-min predictor)
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
