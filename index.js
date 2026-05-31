const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const API_KEY = process.env.MASSIVE_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const WATCHLIST = [
  'TSLA',
  'NVDA',
  'AAPL',
  'PLTR',
  'AMD',
  'META',
  'MSFT',
  'MSTR',
  'SPY',
  'QQQ'
];

const SCAN_INTERVAL_MS = 3 * 60 * 1000;
const UPDATE_INTERVAL_MS = 5 * 60 * 1000;

const COOLDOWN_HOURS = 24;
const UPDATE_BUCKET_PERCENT = 10;

const MIN_DTE = 2;
const MAX_DTE = 45;

const MIN_RELATIVE_VOLUME = 1.15;
const MIN_CONTRACT_SCORE = 75;

const MANUAL_SCAN_COOLDOWN_MS = 60 * 1000;
let lastManualScanAt = 0;

let scannerRunning = false;
let scanIndex = 0;

const CACHE_MS = 90 * 1000;
const stockCache = new Map();
const optionsCache = new Map();

// =====================
// Helpers
// =====================

function fmt(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return Number(n).toLocaleString('en-US');
}

function fmtPrice(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return Number(n).toFixed(2);
}

function fmtPriceSafe(n, fallback = 'تحقق حسب حركة العقد') {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return fallback;
  }

  return Number(n).toFixed(2);
}

function fmtPercent(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return `${Number(n).toFixed(2)}%`;
}

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString();
}

function addHoursIso(hours) {
  const d = new Date();
  d.setHours(d.getHours() + Number(hours));
  return d.toISOString();
}

function formatDate(v) {
  if (!v) return 'غير متوفر';

  return new Date(v).toLocaleString('ar-SA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function daysToExpiration(expiration) {
  if (!expiration) return -999;

  const now = new Date();

  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  const exp = new Date(`${expiration}T00:00:00`);

  return Math.floor(
    (exp - today) / (1000 * 60 * 60 * 24)
  );
}

function calcEMA(values, length) {
  if (!values.length) return 0;

  const k = 2 / (length + 1);
  let ema = values[0];

  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

function isAdmin(msg) {
  const fromId = String(msg.from?.id || '');
  const chatId = String(msg.chat?.id || '');

  return (
    ADMIN_IDS.includes(fromId) ||
    ADMIN_IDS.includes(chatId)
  );
}

function sideArabic(side) {
  return side === 'CALL' ? 'كول' : 'بوت';
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  let code = 'ST-';

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  code += '-';

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

function isUsMarketTimeSaudi() {
  const now = new Date();

  const saTime = new Date(
    now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' })
  );

  const day = saTime.getDay();
  const hour = saTime.getHours();
  const minute = saTime.getMinutes();

  if (day === 0 || day === 6) return false;

  const totalMinutes = hour * 60 + minute;

  const open = 16 * 60 + 30;
  const close = 24 * 60;

  return totalMinutes >= open && totalMinutes <= close;
}

function isSafeEntryTimeSaudi() {
  const now = new Date();

  const saTime = new Date(
    now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' })
  );

  const hour = saTime.getHours();
  const minute = saTime.getMinutes();
  const totalMinutes = hour * 60 + minute;

  const open = 16 * 60 + 30;
  const firstSafeEntry = open + 15;
  const close = 24 * 60;

  return totalMinutes >= firstSafeEntry && totalMinutes <= close;
}

function getType(item) {
  return String(item?.details?.contract_type || '').toUpperCase();
}

function getStrike(item) {
  return Number(item?.details?.strike_price || 0);
}

function getExpiration(item) {
  return item?.details?.expiration_date;
}

function getContractTicker(item) {
  return item?.details?.ticker || null;
}

function getVolume(item) {
  return Number(item?.day?.volume || 0);
}

function getOI(item) {
  return Number(item?.open_interest || 0);
}

function getDelta(item) {
  return Number(item?.greeks?.delta || 0);
}

function getGamma(item) {
  return Number(item?.greeks?.gamma || 0);
}

function getBid(item) {
  return Number(item?.last_quote?.bid || 0);
}

function getAsk(item) {
  return Number(item?.last_quote?.ask || 0);
}

function getMid(item) {
  const bid = getBid(item);
  const ask = getAsk(item);

  if (bid > 0 && ask > 0) {
    return Number(((bid + ask) / 2).toFixed(2));
  }

  return Number(
    item?.last_trade?.price ||
    item?.day?.close ||
    0
  );
}

function spreadPercent(item) {
  const bid = getBid(item);
  const ask = getAsk(item);
  const mid = getMid(item);

  if (!bid || !ask || !mid) return 999;

  return ((ask - bid) / mid) * 100;
}

function distancePercent(strike, price) {
  if (!strike || !price) return 999;

  return Math.abs(
    ((strike - price) / price) * 100
  );
}

function isContractPriceOk(price) {
  return price >= 1.00 && price <= 4.00;
}

function isRateLimitError(err) {
  const status = err.response?.status;
  const apiStatus = err.response?.data?.status;
  const message = String(
    err.response?.data?.error ||
    err.message ||
    ''
  ).toLowerCase();

  return (
    status === 429 ||
    (apiStatus === 'ERROR' && message.includes('exceeded'))
  );
}
// =====================
// Massive + Finnhub API
// =====================

async function apiGet(url) {
  if (!API_KEY) {
    throw new Error('Missing MASSIVE_API_KEY');
  }

  try {
    const res = await axios.get(url, {
      timeout: 15000
    });

    return res.data;
  } catch (err) {
    if (isRateLimitError(err)) {
      console.error('Massive API rate limit reached.');
      throw new Error('MASSIVE_RATE_LIMIT');
    }

    throw err;
  }
}

async function getFinnhubPrice(symbol) {
  if (!FINNHUB_API_KEY) return null;

  try {
    const url =
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`;

    const res = await axios.get(url, {
      timeout: 10000
    });

    const price = Number(res.data?.c || 0);

    if (!price) return null;

    return price;
  } catch (err) {
    console.error(`Finnhub price error ${symbol}:`, err.message);
    return null;
  }
}

async function getStockSnapshot(symbol) {
  const cached = stockCache.get(symbol);

  if (cached && Date.now() - cached.time < CACHE_MS) {
    console.log(`${symbol} stock from cache`);
    return cached.data;
  }

  const now = new Date();
  const to = now.toISOString().split('T')[0];

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 5);
  const from = fromDate.toISOString().split('T')[0];

  const minuteUrl =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/range/1/minute/${from}/${to}?adjusted=true&sort=desc&limit=120&apiKey=${API_KEY}`;

  const prevUrl =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${API_KEY}`;

  const minuteData = await apiGet(minuteUrl);
  const prevData = await apiGet(prevUrl);

  const bars = (minuteData?.results || []).reverse();
  const last = bars[bars.length - 1];
  const prev = prevData?.results?.[0];

  if (!last || !prev || bars.length < 60) return null;

  const finnhubPrice = await getFinnhubPrice(symbol);
  const price = finnhubPrice || Number(last.c);

  const change =
    prev.c ? ((price - prev.c) / prev.c) * 100 : 0;

  const recentBars = bars.slice(-60);
  const closes = recentBars.map(b => Number(b.c));

  const recentHigh = Math.max(...recentBars.map(x => Number(x.h)));
  const recentLow = Math.min(...recentBars.map(x => Number(x.l)));

  const avgVolume =
    recentBars.reduce((sum, b) => sum + Number(b.v || 0), 0) / recentBars.length;

  const relativeVolume =
    avgVolume ? Number((Number(last.v || 0) / avgVolume).toFixed(2)) : 0;

  const vwapSum = recentBars.reduce((sum, b) => {
    const typical = (Number(b.h) + Number(b.l) + Number(b.c)) / 3;
    return sum + typical * Number(b.v || 0);
  }, 0);

  const volumeSum = recentBars.reduce((sum, b) => sum + Number(b.v || 0), 0);
  const vwap = volumeSum ? vwapSum / volumeSum : price;

  const trList = [];

  for (let i = 1; i < recentBars.length; i++) {
    const current = recentBars[i];
    const previous = recentBars[i - 1];

    const tr = Math.max(
      Number(current.h) - Number(current.l),
      Math.abs(Number(current.h) - Number(previous.c)),
      Math.abs(Number(current.l) - Number(previous.c))
    );

    trList.push(tr);
  }

  const atr = trList.length
    ? trList.reduce((a, b) => a + b, 0) / trList.length
    : price * 0.01;

  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  const structureBars = recentBars.slice(-20, -1);

  const recentBreakoutHigh = Math.max(...structureBars.map(b => Number(b.h)));
  const recentBreakdownLow = Math.min(...structureBars.map(b => Number(b.l)));

  const lastClose = Number(last.c);

  const bullishBreakout =
    lastClose > recentBreakoutHigh &&
    price > vwap &&
    ema20 > ema50;

  const bearishBreakdown =
    lastClose < recentBreakdownLow &&
    price < vwap &&
    ema20 < ema50;

  const data = {
    symbol,
    price,
    change,
    recentHigh,
    recentLow,
    volume: Number(last.v || 0),
    avgVolume,
    relativeVolume,
    vwap,
    atr,
    ema20,
    ema50,
    recentBreakoutHigh,
    recentBreakdownLow,
    bullishBreakout,
    bearishBreakdown
  };

  stockCache.set(symbol, {
    time: Date.now(),
    data
  });

  return data;
}

async function getOptionsChain(symbol) {
  const cached = optionsCache.get(symbol);

  if (cached && Date.now() - cached.time < CACHE_MS) {
    console.log(`${symbol} options from cache`);
    return cached.data;
  }

  const url =
    `https://api.massive.com/v3/snapshot/options/${symbol}?limit=250&apiKey=${API_KEY}`;

  const data = await apiGet(url);
  const results = data.results || [];

  optionsCache.set(symbol, {
    time: Date.now(),
    data: results
  });

  return results;
}

// =====================
// Subscription System
// =====================

async function createActivationCode(days = 30) {
  const code = generateCode();
  const expiresAt = addDaysIso(days);

  const { error } = await supabase
    .from('activation_codes')
    .insert({
      code,
      days: Number(days),
      used: false,
      expires_at: expiresAt
    });

  if (error) throw error;

  return {
    code,
    days,
    expiresAt
  };
}

async function getUserAccess(userId) {
  const { data, error } = await supabase
    .from('users_access')
    .select('*')
    .eq('telegram_id', String(userId))
    .maybeSingle();

  if (error) throw error;

  return data || null;
}

async function hasActiveAccess(userId) {
  if (ADMIN_IDS.includes(String(userId))) {
    return true;
  }

  const user = await getUserAccess(userId);

  if (!user || !user.expires_at) return false;

  return new Date(user.expires_at).getTime() > Date.now();
}

async function redeemCode(msg, code) {
  const userId = String(msg.from.id);
  const username = msg.from.username || null;

  const cleanCode = String(code || '')
    .trim()
    .toUpperCase();

  const { data: activation, error } = await supabase
    .from('activation_codes')
    .select('*')
    .eq('code', cleanCode)
    .maybeSingle();

  if (error) throw error;

  if (!activation) {
    return {
      ok: false,
      message: '❌ كود التفعيل غير صحيح.'
    };
  }

  if (activation.used) {
    return {
      ok: false,
      message: '⚠️ هذا الكود مستخدم مسبقاً.'
    };
  }

  if (
    activation.expires_at &&
    new Date(activation.expires_at).getTime() < Date.now()
  ) {
    return {
      ok: false,
      message: '⚠️ هذا الكود منتهي الصلاحية.'
    };
  }

  const userExpiresAt = addDaysIso(activation.days);

  const { error: updateCodeError } = await supabase
    .from('activation_codes')
    .update({
      used: true,
      used_by: userId
    })
    .eq('code', cleanCode)
    .eq('used', false);

  if (updateCodeError) throw updateCodeError;

  const { error: userError } = await supabase
    .from('users_access')
    .upsert(
      {
        telegram_id: userId,
        username,
        expires_at: userExpiresAt
      },
      {
        onConflict: 'telegram_id'
      }
    );

  if (userError) throw userError;

  return {
    ok: true,
    message:
`✅ تم تفعيل اشتراكك بنجاح.

⏳ مدة الاشتراك:
${activation.days} يوم

📅 ينتهي في:
${formatDate(userExpiresAt)}

سيصلك تنبيه تلقائي عند اكتشاف سيولة قوية.`
  };
}
// =====================
// Supabase Trades
// =====================

async function getActiveUsers() {
  const { data, error } = await supabase
    .from('users_access')
    .select('*');

  if (error) throw error;

  const now = Date.now();

  return (data || []).filter(user =>
    user.expires_at &&
    new Date(user.expires_at).getTime() > now
  );
}

async function hasOpenTrade(symbol) {
  const { data, error } = await supabase
    .from('active_trades')
    .select('*')
    .eq('symbol', symbol)
    .eq('status', 'OPEN')
    .maybeSingle();

  if (error) throw error;

  return !!data;
}

async function isInCooldown(symbol) {
  const { data, error } = await supabase
    .from('symbol_cooldowns')
    .select('*')
    .eq('symbol', symbol)
    .maybeSingle();

  if (error) throw error;

  if (!data) return false;

  return new Date(data.cooldown_until).getTime() > Date.now();
}

async function setCooldown(symbol, reason) {
  const { error } = await supabase
    .from('symbol_cooldowns')
    .upsert(
      {
        symbol,
        reason,
        cooldown_until: addHoursIso(COOLDOWN_HOURS)
      },
      {
        onConflict: 'symbol'
      }
    );

  if (error) throw error;
}

async function saveTrade(trade) {
  const { error } = await supabase
    .from('active_trades')
    .insert(trade);

  if (error) throw error;
}

async function getOpenTrades() {
  const { data, error } = await supabase
    .from('active_trades')
    .select('*')
    .eq('status', 'OPEN');

  if (error) throw error;

  return data || [];
}

async function closeTrade(id, reason, currentPrice) {
  const { error } = await supabase
    .from('active_trades')
    .update({
      status: 'CLOSED',
      closed_at: nowIso(),
      close_reason: reason,
      current_contract_price: currentPrice
    })
    .eq('id', id);

  if (error) throw error;
}

// =====================
// Flow Logic
// =====================

function getDynamicDteRange(symbol, score, distance, spread, stockChange) {
  return {
    min: MIN_DTE,
    max: MAX_DTE
  };
}

function scoreContract(item, stock) {
  const volume = getVolume(item);
  const oi = getOI(item);
  const delta = Math.abs(getDelta(item));
  const gamma = getGamma(item);
  const strike = getStrike(item);
  const price = getMid(item);
  const spread = spreadPercent(item);
  const distance = distancePercent(strike, stock.price);
  const premium = volume * price * 100;

  let score = 0;

  if (volume >= 1000) score += 15;
  if (volume >= 300) score += 5;
  if (oi > 0 && volume > oi * 1.5) score += 15;
  if (premium >= 100000) score += 15;
  if (premium >= 50000) score += 5;
  if (delta >= 0.25 && delta <= 0.60) score += 15;
  if (gamma >= 0.02) score += 10;
  if (distance <= 3) score += 10;
  if (spread <= 12) score += 10;
  if (spread <= 20) score += 5;
  if (isContractPriceOk(price)) score += 5;

  score = Math.min(score, 100);

  return {
    score,
    volume,
    oi,
    delta,
    gamma,
    strike,
    price,
    spread,
    distance,
    premium
  };
}

function detectSide(chain, stock) {
  let callScore = 0;
  let putScore = 0;

  for (const item of chain) {
    const type = getType(item);
    const s = scoreContract(item, stock).score;

    if (type === 'CALL') callScore += s;
    if (type === 'PUT') putScore += s;
  }

  console.log('Side scores:', {
    symbol: stock.symbol,
    change: stock.change,
    callScore,
    putScore,
    price: stock.price,
    vwap: stock.vwap,
    ema20: stock.ema20,
    ema50: stock.ema50,
    bullishBreakout: stock.bullishBreakout,
    bearishBreakdown: stock.bearishBreakdown
  });

  if (
    callScore > putScore * 1.15 &&
    stock.change > 0.15 &&
    stock.price > stock.vwap &&
    stock.ema20 > stock.ema50 &&
    stock.bullishBreakout
  ) {
    return 'CALL';
  }

  if (
    putScore > callScore * 1.15 &&
    stock.change < -0.15 &&
    stock.price < stock.vwap &&
    stock.ema20 < stock.ema50 &&
    stock.bearishBreakdown
  ) {
    return 'PUT';
  }

  return null;
}

function pickBestContract(symbol, chain, stock) {
  const side = detectSide(chain, stock);

  if (!side) {
    console.log(`${symbol} skipped: no clear side or no technical timing`);
    return null;
  }

  const candidates = [];

  const rejected = {
    dte: 0,
    score: 0,
    price: 0,
    spread: 0,
    distance: 0,
    delta: 0,
    volume: 0,
    noExpiration: 0,
    wrongSide: 0,
    passed: 0
  };

  for (const item of chain) {
    if (getType(item) !== side) {
      rejected.wrongSide++;
      continue;
    }

    const exp = getExpiration(item);

    if (!exp) {
      rejected.noExpiration++;
      continue;
    }

    const metrics = scoreContract(item, stock);
    const dte = daysToExpiration(exp);

    const dteRange = getDynamicDteRange(
      symbol,
      metrics.score,
      metrics.distance,
      metrics.spread,
      stock.change
    );

    if (dte < dteRange.min || dte > dteRange.max) {
      rejected.dte++;
      continue;
    }

    if (metrics.score < MIN_CONTRACT_SCORE) {
      rejected.score++;
      continue;
    }

    if (!isContractPriceOk(metrics.price)) {
      rejected.price++;
      continue;
    }

    if (metrics.spread > 25) {
      rejected.spread++;
      continue;
    }

    if (metrics.distance > 8) {
      rejected.distance++;
      continue;
    }

    if (metrics.delta < 0.18 || metrics.delta > 0.75) {
      rejected.delta++;
      continue;
    }

    if (metrics.volume < 250) {
      rejected.volume++;
      continue;
    }

    rejected.passed++;

    candidates.push({
      item,
      side,
      dte,
      dteRange,
      ...metrics
    });
  }

  console.log(`${symbol} filter report:`, rejected);

  candidates.sort((a, b) => {
    const rankA =
      a.score +
      Math.max(0, 20 - a.spread) +
      Math.max(0, 10 - a.distance) +
      Math.min(a.premium / 10000, 20);

    const rankB =
      b.score +
      Math.max(0, 20 - b.spread) +
      Math.max(0, 10 - b.distance) +
      Math.min(b.premium / 10000, 20);

    return rankB - rankA;
  });

  if (!candidates.length) {
    console.log(`${symbol} skipped: no contract passed filters`);
    return null;
  }

  console.log(`${symbol} best contract:`, {
    side: candidates[0].side,
    strike: candidates[0].strike,
    expiration: getExpiration(candidates[0].item),
    price: candidates[0].price,
    score: candidates[0].score,
    volume: candidates[0].volume,
    spread: candidates[0].spread,
    delta: candidates[0].delta,
    distance: candidates[0].distance,
    dte: candidates[0].dte
  });

  return candidates[0];
}

function buildLevels(side, stock) {
  const atr = Number(stock.atr || stock.price * 0.01);

  if (side === 'CALL') {
    return {
      stop: Number((stock.price - atr * 1.2).toFixed(2)),
      target1: Number((stock.price + atr * 1.0).toFixed(2)),
      target2: Number((stock.price + atr * 1.8).toFixed(2)),
      target3: Number((stock.price + atr * 2.6).toFixed(2))
    };
  }

  return {
    stop: Number((stock.price + atr * 1.2).toFixed(2)),
    target1: Number((stock.price - atr * 1.0).toFixed(2)),
    target2: Number((stock.price - atr * 1.8).toFixed(2)),
    target3: Number((stock.price - atr * 2.6).toFixed(2))
  };
}

function isValidLevels(side, stock, levels) {
  if (side === 'CALL') {
    return (
      levels.stop < stock.price &&
      levels.target1 > stock.price &&
      levels.target2 > levels.target1 &&
      levels.target3 > levels.target2
    );
  }

  if (side === 'PUT') {
    return (
      levels.stop > stock.price &&
      levels.target1 < stock.price &&
      levels.target2 < levels.target1 &&
      levels.target3 < levels.target2
    );
  }

  return false;
}
// =====================
// Messages
// =====================

async function sendToActiveUsers(text) {
  const users = await getActiveUsers();

  const receivers = new Set();

  for (const id of ADMIN_IDS) {
    if (id) receivers.add(String(id));
  }

  for (const user of users) {
    if (user.telegram_id) {
      receivers.add(String(user.telegram_id));
    }
  }

  if (!receivers.size) {
    console.log('No receivers to send.');
    return;
  }

  for (const chatId of receivers) {
    try {
      await bot.sendMessage(chatId, text);

      await new Promise(resolve =>
        setTimeout(resolve, 250)
      );
    } catch (err) {
      console.error(
        'Send failed:',
        chatId,
        err.message
      );
    }
  }
}

function buildEntryMessage(symbol, stock, best, levels) {
  return `🚨 تم اكتشاف صفقة سيولة + توقيت دخول

📊 السهم: ${symbol}
📈 النوع: ${sideArabic(best.side)}

🎯 السترايك: ${best.strike}
📅 الانتهاء: ${getExpiration(best.item)}
⏳ المدة: ${best.dte} يوم

💰 سعر العقد: ${fmtPrice(best.price)}
📊 درجة العقد: ${best.score} / 100

📍 سعر السهم: ${fmtPrice(stock.price)}
📊 VWAP: ${fmtPrice(stock.vwap)}
📈 EMA20: ${fmtPrice(stock.ema20)}
📉 EMA50: ${fmtPrice(stock.ema50)}
🔥 RVOL: ${fmtPrice(stock.relativeVolume)}

🛑 وقف السهم: ${fmtPrice(levels.stop)}
🎯 الهدف الأول: ${fmtPrice(levels.target1)}
🎯 الهدف الثاني: ${fmtPrice(levels.target2)}
🎯 الهدف الثالث: ${fmtPriceSafe(levels.target3)}

━━━━━━━━━━━━━━
🔥 سبب الالتقاط:
• سيولة ${sideArabic(best.side)} أقوى
• توقيت دخول فني مؤكد
• حجم العقد: ${fmt(best.volume)}
• العقود المفتوحة: ${fmt(best.oi)}
• قيمة التداول التقريبية: $${fmt(best.premium)}
• Delta: ${fmtPrice(best.delta)}
• Gamma: ${fmtPrice(best.gamma)}
• قرب السترايك من السعر: ${fmtPercent(best.distance)}
• السبريد: ${fmtPercent(best.spread)}

━━━━━━━━━━━━━━
تنبيه:
هذه قراءة آلية وليست توصية شراء أو بيع.`;
}

function buildUpdateMessage(trade, currentContractPrice, stockPrice, pnl) {
  return `🔄 تحديث الصفقة

📊 السهم: ${trade.symbol}
📈 النوع: ${sideArabic(trade.side)}

💰 الدخول: ${fmtPrice(trade.entry_contract_price)}
💰 الحالي: ${fmtPrice(currentContractPrice)}

📈 النتيجة الحالية: ${fmtPercent(pnl)}

📍 سعر السهم الحالي: ${fmtPrice(stockPrice)}
🛑 وقف السهم: ${fmtPrice(trade.stock_stop_price)}
🎯 الهدف الأول: ${fmtPrice(trade.stock_target_1)}
🎯 الهدف الثاني: ${fmtPrice(trade.stock_target_2)}
🎯 الهدف الثالث: ${fmtPriceSafe(trade.stock_target_3)}`;
}

// =====================
// Scanner
// =====================

async function scanSymbol(symbol) {
  console.log(`--- Checking ${symbol} ---`);

  if (!isSafeEntryTimeSaudi()) {
    console.log(`${symbol} skipped: first 15 minutes blocked`);
    return;
  }

  if (await hasOpenTrade(symbol)) {
    console.log(`${symbol} skipped: open trade exists`);
    return;
  }

  if (await isInCooldown(symbol)) {
    console.log(`${symbol} skipped: cooldown`);
    return;
  }

  const stock = await getStockSnapshot(symbol);

  if (!stock) {
    console.log(`${symbol} skipped: no stock snapshot`);
    return;
  }

  console.log(`${symbol} stock snapshot:`, {
    price: stock.price,
    change: stock.change,
    recentHigh: stock.recentHigh,
    recentLow: stock.recentLow,
    volume: stock.volume,
    avgVolume: stock.avgVolume,
    relativeVolume: stock.relativeVolume,
    vwap: stock.vwap,
    atr: stock.atr,
    ema20: stock.ema20,
    ema50: stock.ema50,
    bullishBreakout: stock.bullishBreakout,
    bearishBreakdown: stock.bearishBreakdown
  });

  if (stock.relativeVolume < MIN_RELATIVE_VOLUME) {
    console.log(`${symbol} skipped: weak stock volume`, {
      volume: stock.volume,
      avgVolume: stock.avgVolume,
      relativeVolume: stock.relativeVolume,
      minRequired: MIN_RELATIVE_VOLUME
    });
    return;
  }

  const chain = await getOptionsChain(symbol);

  if (!chain.length) {
    console.log(`${symbol} skipped: empty options chain`);
    return;
  }

  console.log(`${symbol} chain count: ${chain.length}`);

  const best = pickBestContract(symbol, chain, stock);

  if (!best) {
    console.log(`${symbol} skipped: no valid contract`);
    return;
  }

  const levels = buildLevels(best.side, stock);

  if (!isValidLevels(best.side, stock, levels)) {
    console.log(`${symbol} skipped: invalid levels`, {
      side: best.side,
      price: stock.price,
      levels
    });

    return;
  }

  const trade = {
    symbol,
    side: best.side,
    strike: best.strike,
    expiration: getExpiration(best.item),
    contract_ticker: getContractTicker(best.item),
    entry_contract_price: best.price,
    current_contract_price: best.price,
    stock_entry_price: stock.price,
    stock_stop_price: levels.stop,
    stock_target_1: levels.target1,
    stock_target_2: levels.target2,
    stock_target_3: levels.target3,
    flow_score: best.score,
    status: 'OPEN',
    opened_at: nowIso(),
    last_update_bucket: 0,
    tp1_hit: false,
    tp2_hit: false,
    tp3_hit: false
  };

  await saveTrade(trade);

  console.log(`${symbol} trade saved and sending alert`);

  await sendToActiveUsers(
    buildEntryMessage(symbol, stock, best, levels)
  );
}

async function scanNextSymbol() {
  if (scannerRunning) {
    console.log('Scanner already running - skipped');
    return;
  }

  scannerRunning = true;

  const symbol = WATCHLIST[scanIndex];

  scanIndex = (scanIndex + 1) % WATCHLIST.length;

  try {
    console.log(`Scanning one symbol: ${symbol}`);

    await scanSymbol(symbol);

    console.log(`Scan completed: ${symbol}`);
  } catch (err) {
    if (err.message === 'MASSIVE_RATE_LIMIT') {
      console.error(
        `Scan stopped for ${symbol}: Massive API limit reached.`
      );
    } else {
      console.error(
        `Scan error ${symbol}:`,
        err.response?.data || err.message
      );
    }
  } finally {
    scannerRunning = false;
  }
}

// =====================
// Trade Updates
// =====================

async function getContractSnapshotFromChain(symbol, contractTicker) {
  const chain = await getOptionsChain(symbol);

  const item = chain.find(x =>
    getContractTicker(x) === contractTicker
  );

  if (!item) return null;

  return {
    price: getMid(item),
    spread: spreadPercent(item),
    volume: getVolume(item),
    oi: getOI(item),
    delta: Math.abs(getDelta(item)),
    gamma: getGamma(item)
  };
}

function isContractRiskBroken(entryPrice, currentPrice, spread) {
  if (!entryPrice || !currentPrice) return false;

  const pnl = ((currentPrice - entryPrice) / entryPrice) * 100;

  if (pnl <= -35) return true;
  if (spread >= 35) return true;

  return false;
}

async function updateOpenTrades() {
  const trades = await getOpenTrades();

  for (const trade of trades) {
    try {
      const stock = await getStockSnapshot(trade.symbol);
      if (!stock) continue;

      const contractSnapshot = await getContractSnapshotFromChain(
        trade.symbol,
        trade.contract_ticker
      );

      if (!contractSnapshot || !contractSnapshot.price) continue;

      const contractPrice = contractSnapshot.price;
      const currentSpread = contractSnapshot.spread;

      const entryPrice = Number(trade.entry_contract_price);

      const pnl = entryPrice
        ? ((contractPrice - entryPrice) / entryPrice) * 100
        : 0;

      if (isContractRiskBroken(entryPrice, contractPrice, currentSpread)) {
        await closeTrade(trade.id, 'CONTRACT_RISK', contractPrice);
        await setCooldown(trade.symbol, 'ضعف العقد أو توسع السبريد');

        await sendToActiveUsers(
`⚠️ تم إغلاق الصفقة بسبب ضعف العقد

📊 السهم: ${trade.symbol}
📈 النوع: ${sideArabic(trade.side)}

💰 الدخول: ${fmtPrice(entryPrice)}
💰 الخروج: ${fmtPrice(contractPrice)}

📉 النتيجة النهائية: ${fmtPercent(pnl)}
📊 السبريد الحالي: ${fmtPercent(currentSpread)}

سبب الإغلاق:
ضعف سعر العقد أو توسع السبريد لحماية رأس المال.`
        );

        continue;
      }

      const currentBucket = Math.trunc(pnl / UPDATE_BUCKET_PERCENT);
      const lastBucket = Number(trade.last_update_bucket || 0);

      let hitStop = false;
      let hitTp1 = false;
      let hitTp2 = false;
      let hitTp3 = false;

      if (trade.side === 'CALL') {
        hitStop = stock.price <= Number(trade.stock_stop_price);
        hitTp1 = stock.price >= Number(trade.stock_target_1);
        hitTp2 = stock.price >= Number(trade.stock_target_2);
        hitTp3 = stock.price >= Number(trade.stock_target_3);
      }

      if (trade.side === 'PUT') {
        hitStop = stock.price >= Number(trade.stock_stop_price);
        hitTp1 = stock.price <= Number(trade.stock_target_1);
        hitTp2 = stock.price <= Number(trade.stock_target_2);
        hitTp3 = stock.price <= Number(trade.stock_target_3);
      }

      if (hitTp3) {
        await closeTrade(trade.id, 'TP3', contractPrice);
        await setCooldown(trade.symbol, 'تم تحقيق الهدف الثالث');

        await sendToActiveUsers(
`✅ تم إغلاق الصفقة على الهدف الثالث

📊 السهم: ${trade.symbol}
📈 النوع: ${sideArabic(trade.side)}

💰 الدخول: ${fmtPrice(entryPrice)}
💰 الخروج: ${fmtPrice(contractPrice)}

📈 النتيجة النهائية: ${fmtPercent(pnl)}

🎯 هدف السهم الثالث: ${fmtPriceSafe(trade.stock_target_3)}`
        );

        continue;
      }

      if (hitStop) {
        await closeTrade(trade.id, 'SL', contractPrice);
        await setCooldown(trade.symbol, 'تم ضرب الوقف');

        await sendToActiveUsers(
`🛑 تم إغلاق الصفقة على وقف الخسارة

📊 السهم: ${trade.symbol}
📈 النوع: ${sideArabic(trade.side)}

💰 الدخول: ${fmtPrice(entryPrice)}
💰 الخروج: ${fmtPrice(contractPrice)}

📉 النتيجة النهائية: ${fmtPercent(pnl)}

🛑 وقف السهم: ${fmtPrice(trade.stock_stop_price)}`
        );

        continue;
      }

      if (hitTp2 && !trade.tp2_hit) {
        await supabase
          .from('active_trades')
          .update({
            tp1_hit: true,
            tp2_hit: true,
            current_contract_price: contractPrice,
            last_update_bucket: currentBucket
          })
          .eq('id', trade.id);

        await sendToActiveUsers(
`🎯 تحقق الهدف الثاني

📊 السهم: ${trade.symbol}
📈 النوع: ${sideArabic(trade.side)}

💰 الدخول: ${fmtPrice(entryPrice)}
💰 الحالي: ${fmtPrice(contractPrice)}

📈 الربح الحالي: ${fmtPercent(pnl)}

🎯 هدف السهم الثاني: ${fmtPrice(trade.stock_target_2)}`
        );

        continue;
      }

      if (hitTp1 && !trade.tp1_hit) {
        await supabase
          .from('active_trades')
          .update({
            tp1_hit: true,
            current_contract_price: contractPrice,
            last_update_bucket: currentBucket
          })
          .eq('id', trade.id);

        await sendToActiveUsers(
`🎯 تحقق الهدف الأول

📊 السهم: ${trade.symbol}
📈 النوع: ${sideArabic(trade.side)}

💰 الدخول: ${fmtPrice(entryPrice)}
💰 الحالي: ${fmtPrice(contractPrice)}

📈 الربح الحالي: ${fmtPercent(pnl)}

🎯 هدف السهم الأول: ${fmtPrice(trade.stock_target_1)}`
        );

        continue;
      }

      if (currentBucket !== lastBucket && Math.abs(currentBucket) >= 1) {
        await supabase
          .from('active_trades')
          .update({
            current_contract_price: contractPrice,
            last_update_bucket: currentBucket
          })
          .eq('id', trade.id);

        await sendToActiveUsers(
          buildUpdateMessage(
            trade,
            contractPrice,
            stock.price,
            pnl
          )
        );
      } else {
        await supabase
          .from('active_trades')
          .update({
            current_contract_price: contractPrice
          })
          .eq('id', trade.id);
      }

      await new Promise(resolve =>
        setTimeout(resolve, 500)
      );
    } catch (err) {
      if (err.message === 'MASSIVE_RATE_LIMIT') {
        console.error(
          `Update stopped for ${trade.symbol}: Massive API limit reached.`
        );
      } else {
        console.error(
          `Update trade error ${trade.symbol}:`,
          err.response?.data || err.message
        );
      }
    }
  }
}
// =====================
// Bot Commands
// =====================

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
`🎯 أهلاً بك في ST صائد السيولة

البوت يراقب الأسهم الأمريكية عالية السيولة ويبحث عن صفقات مبنية على:
السيولة + توقيت الدخول الفني.

الأوامر:
/mysub حالة الاشتراك
/myid معرفة رقم حسابك
/status حالة البوت
/scan فحص يدوي
/open الصفقات المفتوحة

تنبيه:
البوت أداة قراءة آلية وليست توصية شراء أو بيع.`
  );
});

bot.onText(/\/myid/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
`from.id:
${msg.from.id}

chat.id:
${msg.chat.id}`
  );
});

bot.onText(/\/mysub/, async (msg) => {
  try {
    const user = await getUserAccess(msg.from.id);

    if (!user) {
      return bot.sendMessage(msg.chat.id, '❌ لا يوجد اشتراك فعال.');
    }

    const active =
      new Date(user.expires_at).getTime() > Date.now();

    await bot.sendMessage(
      msg.chat.id,
`📊 حالة الاشتراك

${active ? '✅ فعال' : '❌ منتهي'}

📅 ينتهي في:
${formatDate(user.expires_at)}`
    );
  } catch (err) {
    await bot.sendMessage(msg.chat.id, 'حدث خطأ أثناء فحص الاشتراك.');
  }
});

bot.onText(/\/create (\d+)/, async (msg, match) => {
  try {
    if (!isAdmin(msg)) {
      return bot.sendMessage(msg.chat.id, '🚫 هذا الأمر للإدارة فقط');
    }

    const days = Number(match[1]);

    if (!days || days <= 0) {
      return bot.sendMessage(
        msg.chat.id,
        '⚠️ اكتب عدد أيام صحيح. مثال: /create 30'
      );
    }

    const result = await createActivationCode(days);

    await bot.sendMessage(
      msg.chat.id,
`✅ تم إنشاء كود تفعيل جديد

🔑 الكود:
${result.code}

⏳ مدة الاشتراك:
${days} يوم

📅 صلاحية الكود:
${formatDate(result.expiresAt)}`
    );
  } catch (err) {
    await bot.sendMessage(
      msg.chat.id,
      `❌ فشل إنشاء الكود\n${err.message}`
    );
  }
});

bot.onText(/\/adduser (\d+) (\d+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const telegramId = String(match[1]);
  const days = Number(match[2]);

  const d = new Date();
  d.setDate(d.getDate() + days);

  const { error } = await supabase
    .from('users_access')
    .upsert(
      {
        telegram_id: telegramId,
        expires_at: d.toISOString()
      },
      {
        onConflict: 'telegram_id'
      }
    );

  if (error) {
    return bot.sendMessage(msg.chat.id, `خطأ:\n${error.message}`);
  }

  await bot.sendMessage(
    msg.chat.id,
`✅ تم تفعيل المستخدم

ID:
${telegramId}

المدة:
${days} يوم`
  );
});

bot.onText(/\/scan/, async (msg) => {
  if (!isAdmin(msg)) return;

  const now = Date.now();

  if (now - lastManualScanAt < MANUAL_SCAN_COOLDOWN_MS) {
    return bot.sendMessage(
      msg.chat.id,
      '⏳ انتظر دقيقة بين كل فحص يدوي حتى لا نضغط على Massive API.'
    );
  }

  lastManualScanAt = now;

  if (!isUsMarketTimeSaudi()) {
    return bot.sendMessage(
      msg.chat.id,
      '⏸ السوق الأمريكي مغلق حالياً. الفحص يعمل فقط وقت السوق.'
    );
  }

  await bot.sendMessage(msg.chat.id, '🔎 بدأ فحص سهم واحد الآن...');

  await scanNextSymbol();

  await bot.sendMessage(
    msg.chat.id,
    '✅ انتهى الفحص. راجع Railway Logs.'
  );
});

bot.onText(/\/open/, async (msg) => {
  if (!isAdmin(msg)) return;

  const trades = await getOpenTrades();

  if (!trades.length) {
    return bot.sendMessage(msg.chat.id, 'لا توجد صفقات مفتوحة.');
  }

  const text = trades.map(t =>
`📊 ${t.symbol} ${sideArabic(t.side)}
🎯 ${t.strike}
📅 ${t.expiration}
💰 الدخول: ${fmtPrice(t.entry_contract_price)}
🛑 الوقف: ${fmtPrice(t.stock_stop_price)}
🎯 الهدف الأول: ${fmtPrice(t.stock_target_1)}
🎯 الهدف الثاني: ${fmtPrice(t.stock_target_2)}
🎯 الهدف الثالث: ${fmtPriceSafe(t.stock_target_3)}`
  ).join('\n\n');

  await bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/status/, async (msg) => {
  if (!isAdmin(msg)) return;

  const users = await getActiveUsers();
  const trades = await getOpenTrades();

  await bot.sendMessage(
    msg.chat.id,
`📊 حالة البوت

✅ البوت يعمل

👥 المشتركين الفعالين:
${users.length}

📌 الصفقات المفتوحة:
${trades.length}

🔎 السهم القادم:
${WATCHLIST[scanIndex]}

⏱ وقت السوق:
${isUsMarketTimeSaudi() ? 'مفتوح' : 'مغلق'}

🧪 الفلاتر:
Finnhub Price + Massive Options
No 0DTE / No 1DTE
VWAP + ATR + RVOL
EMA20 / EMA50
Breakout / Breakdown Timing
Contract Risk Protection

📅 مدة العقود:
من ${MIN_DTE} يوم إلى ${MAX_DTE} يوم

📊 أقل RVOL:
${MIN_RELATIVE_VOLUME}

📊 أقل Score للعقد:
${MIN_CONTRACT_SCORE}`
  );
});

bot.on('message', async (msg) => {
  const text = String(msg.text || '').trim();

  if (!text) return;
  if (text.startsWith('/')) return;

  const isActivationCode =
    /^ST-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(text);

  if (!isActivationCode) return;

  try {
    const result = await redeemCode(msg, text);
    await bot.sendMessage(msg.chat.id, result.message);
  } catch (err) {
    await bot.sendMessage(
      msg.chat.id,
      '❌ حدث خطأ أثناء تفعيل الكود.'
    );
  }
});

// =====================
// Intervals
// =====================

setInterval(() => {
  if (!isUsMarketTimeSaudi()) {
    console.log('Market closed - scanner paused');
    return;
  }

  scanNextSymbol();
}, SCAN_INTERVAL_MS);

setInterval(() => {
  if (!isUsMarketTimeSaudi()) {
    console.log('Market closed - trade updates paused');
    return;
  }

  updateOpenTrades();
}, UPDATE_INTERVAL_MS);

console.log('🎯 ST Liquidity Hunter Bot Started - Liquidity + Entry Timing Version');
