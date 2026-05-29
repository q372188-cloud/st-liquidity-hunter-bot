const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const API_KEY = process.env.MASSIVE_API_KEY;

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

// فحص سهم واحد كل دقيقة لتخفيف ضغط Massive
const SCAN_INTERVAL_MS = 60 * 1000;

// تحديث الصفقات كل 5 دقائق
const UPDATE_INTERVAL_MS = 5 * 60 * 1000;

const COOLDOWN_HOURS = 24;

let scannerRunning = false;
let scanIndex = 0;

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
  const today = new Date();
  const exp = new Date(expiration);

  return Math.ceil(
    (exp - today) / (1000 * 60 * 60 * 24)
  );
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
  return price >= 1.50 && price <= 2.20;
}

// =====================
// Massive API
// =====================

async function apiGet(url) {
  if (!API_KEY) {
    throw new Error('Missing MASSIVE_API_KEY');
  }

  const res = await axios.get(url);
  return res.data;
}

async function getStockSnapshot(symbol) {
  const now = new Date();
  const to = now.toISOString().split('T')[0];

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 5);
  const from = fromDate.toISOString().split('T')[0];

  const minuteUrl =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/range/1/minute/${from}/${to}?adjusted=true&sort=desc&limit=20&apiKey=${API_KEY}`;

  const prevUrl =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${API_KEY}`;

  const [minuteData, prevData] = await Promise.all([
    apiGet(minuteUrl),
    apiGet(prevUrl)
  ]);

  const bars = minuteData?.results || [];
  const last = bars[0];
  const prev = prevData?.results?.[0];

  if (!last || !prev) return null;

  const price = last.c;

  const change =
    prev.c ? ((price - prev.c) / prev.c) * 100 : 0;

  const recentHigh = Math.max(...bars.map(x => x.h));
  const recentLow = Math.min(...bars.map(x => x.l));

  return {
    symbol,
    price,
    change,
    recentHigh,
    recentLow,
    volume: last.v
  };
}

async function getOptionsChain(symbol) {
  const url =
    `https://api.massive.com/v3/snapshot/options/${symbol}?limit=250&apiKey=${API_KEY}`;

  const data = await apiGet(url);

  return data.results || [];
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
  const fastSymbols = ['SPY', 'QQQ', 'TSLA', 'NVDA', 'MSTR'];
  const isFast = fastSymbols.includes(symbol);

  if (
    isFast &&
    score >= 90 &&
    distance <= 1.5 &&
    spread <= 10 &&
    Math.abs(stockChange) >= 1
  ) {
    return { min: 0, max: 3 };
  }

  if (score >= 82 && distance <= 3 && spread <= 12) {
    return { min: 3, max: 7 };
  }

  if (score >= 75 && distance <= 5) {
    return { min: 7, max: 14 };
  }

  return { min: 14, max: 30 };
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
  if (oi > 0 && volume > oi * 2) score += 20;
  if (premium >= 100000) score += 15;
  if (delta >= 0.25 && delta <= 0.60) score += 15;
  if (gamma >= 0.02) score += 10;
  if (distance <= 3) score += 10;
  if (spread <= 12) score += 10;
  if (isContractPriceOk(price)) score += 5;

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

  if (callScore > putScore * 1.25 && stock.change > 0) {
    return 'CALL';
  }

  if (putScore > callScore * 1.25 && stock.change < 0) {
    return 'PUT';
  }

  return null;
}

function pickBestContract(symbol, chain, stock) {
  const side = detectSide(chain, stock);

  if (!side) return null;

  const candidates = [];

  for (const item of chain) {
    if (getType(item) !== side) continue;

    const exp = getExpiration(item);
    if (!exp) continue;

    const metrics = scoreContract(item, stock);
    const dte = daysToExpiration(exp);

    const dteRange = getDynamicDteRange(
      symbol,
      metrics.score,
      metrics.distance,
      metrics.spread,
      stock.change
    );

    if (dte < dteRange.min || dte > dteRange.max) continue;
    if (metrics.score < 75) continue;
    if (!isContractPriceOk(metrics.price)) continue;
    if (metrics.spread > 15) continue;
    if (metrics.distance > 7) continue;
    if (metrics.delta < 0.20 || metrics.delta > 0.70) continue;
    if (metrics.volume < 1000) continue;

    candidates.push({
      item,
      side,
      dte,
      dteRange,
      ...metrics
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

function buildLevels(side, stock) {
  const range = Math.abs(stock.recentHigh - stock.recentLow);
  const buffer = Math.max(range * 0.25, stock.price * 0.006);

  if (side === 'CALL') {
    return {
      stop: Number((stock.recentLow - buffer).toFixed(2)),
      target1: Number((stock.recentHigh + buffer).toFixed(2)),
      target2: Number((stock.recentHigh + buffer * 2).toFixed(2))
    };
  }

  return {
    stop: Number((stock.recentHigh + buffer).toFixed(2)),
    target1: Number((stock.recentLow - buffer).toFixed(2)),
    target2: Number((stock.recentLow - buffer * 2).toFixed(2))
  };
}

// =====================
// Messages
// =====================

async function sendToActiveUsers(text) {
  const users = await getActiveUsers();

  if (!users.length) {
    console.log('No active users to send.');
    return;
  }

  for (const user of users) {
    try {
      await bot.sendMessage(user.telegram_id, text);

      await new Promise(resolve =>
        setTimeout(resolve, 250)
      );
    } catch (err) {
      console.error(
        'Send failed:',
        user.telegram_id,
        err.message
      );
    }
  }
}

function buildEntryMessage(symbol, stock, best, levels) {
  return `🚨 تم اكتشاف دخول سيولة قوية

📊 السهم: ${symbol}
📈 النوع: ${sideArabic(best.side)}

🎯 السترايك: ${best.strike}
📅 الانتهاء: ${getExpiration(best.item)}
⏳ المدة: ${best.dte} يوم

💰 سعر العقد: ${fmtPrice(best.price)}
📊 درجة الفرصة: ${best.score} / 100

🛑 وقف السهم: ${fmtPrice(levels.stop)}
🎯 الهدف الأول: ${fmtPrice(levels.target1)}
🎯 الهدف الثاني: ${fmtPrice(levels.target2)}

━━━━━━━━━━━━━━
🔥 سبب الالتقاط:
• حجم العقد: ${fmt(best.volume)}
• العقود المفتوحة: ${fmt(best.oi)}
• قيمة التداول التقريبية: $${fmt(best.premium)}
• Delta: ${fmtPrice(best.delta)}
• Gamma: ${fmtPrice(best.gamma)}
• قرب السترايك من السعر: ${fmtPercent(best.distance)}
• السبريد: ${fmtPercent(best.spread)}

━━━━━━━━━━━━━━
تنبيه:
هذه قراءة سيولة آلية وليست توصية شراء أو بيع.`;
}

function buildUpdateMessage(trade, currentContractPrice, stockPrice) {
  const pnl =
    trade.entry_contract_price
      ? ((currentContractPrice - trade.entry_contract_price) / trade.entry_contract_price) * 100
      : 0;

  return `🔄 تحديث الصفقة

📊 السهم: ${trade.symbol}
📈 النوع: ${sideArabic(trade.side)}

💰 الدخول: ${fmtPrice(trade.entry_contract_price)}
💰 الحالي: ${fmtPrice(currentContractPrice)}
📈 النتيجة الحالية: ${fmtPercent(pnl)}

📍 سعر السهم الحالي: ${fmtPrice(stockPrice)}
🛑 وقف السهم: ${fmtPrice(trade.stock_stop_price)}
🎯 الهدف الأول: ${fmtPrice(trade.stock_target_1)}`;
}

// =====================
// Scanner
// =====================

async function scanSymbol(symbol) {
  if (await hasOpenTrade(symbol)) return;
  if (await isInCooldown(symbol)) return;

  const stock = await getStockSnapshot(symbol);
  if (!stock) return;

  const chain = await getOptionsChain(symbol);
  if (!chain.length) return;

  const best = pickBestContract(symbol, chain, stock);
  if (!best) return;

  const levels = buildLevels(best.side, stock);

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
    flow_score: best.score,
    status: 'OPEN',
    opened_at: nowIso()
  };

  await saveTrade(trade);

  await sendToActiveUsers(
    buildEntryMessage(symbol, stock, best, levels)
  );
}

async function scanNextSymbol() {
  if (scannerRunning) return;

  scannerRunning = true;

  const symbol = WATCHLIST[scanIndex];

  scanIndex = (scanIndex + 1) % WATCHLIST.length;

  try {
    console.log(`Scanning one symbol: ${symbol}`);

    await scanSymbol(symbol);

    console.log(`Scan completed: ${symbol}`);
  } catch (err) {
    console.error(
      `Scan error ${symbol}:`,
      err.response?.data || err.message
    );
  } finally {
    scannerRunning = false;
  }
}

// =====================
// Trade Updates
// =====================

async function getContractPriceFromChain(symbol, contractTicker) {
  const chain = await getOptionsChain(symbol);

  const item = chain.find(x =>
    getContractTicker(x) === contractTicker
  );

  if (!item) return null;

  return getMid(item);
}

async function updateOpenTrades() {
  const trades = await getOpenTrades();

  for (const trade of trades) {
    try {
      const stock = await getStockSnapshot(trade.symbol);
      if (!stock) continue;

      const contractPrice = await getContractPriceFromChain(
        trade.symbol,
        trade.contract_ticker
      );

      if (!contractPrice) continue;

      let hitStop = false;
      let hitTarget = false;

      if (trade.side === 'CALL') {
        hitStop = stock.price <= Number(trade.stock_stop_price);
        hitTarget = stock.price >= Number(trade.stock_target_1);
      }

      if (trade.side === 'PUT') {
        hitStop = stock.price >= Number(trade.stock_stop_price);
        hitTarget = stock.price <= Number(trade.stock_target_1);
      }

      if (hitTarget) {
        await closeTrade(trade.id, 'TP1', contractPrice);
        await setCooldown(trade.symbol, 'تم تحقيق الهدف');

        await sendToActiveUsers(
`✅ تحقق الهدف الأول

📊 السهم: ${trade.symbol}
📈 النوع: ${sideArabic(trade.side)}

💰 الدخول: ${fmtPrice(trade.entry_contract_price)}
💰 الحالي: ${fmtPrice(contractPrice)}

🎯 هدف السهم: ${fmtPrice(trade.stock_target_1)}`
        );

        continue;
      }

      if (hitStop) {
        await closeTrade(trade.id, 'SL', contractPrice);
        await setCooldown(trade.symbol, 'تم ضرب الوقف');

        await sendToActiveUsers(
`🛑 تم ضرب الوقف

📊 السهم: ${trade.symbol}
📈 النوع: ${sideArabic(trade.side)}

💰 الدخول: ${fmtPrice(trade.entry_contract_price)}
💰 الحالي: ${fmtPrice(contractPrice)}

🛑 وقف السهم: ${fmtPrice(trade.stock_stop_price)}`
        );

        continue;
      }

      await supabase
        .from('active_trades')
        .update({
          current_contract_price: contractPrice
        })
        .eq('id', trade.id);

      await sendToActiveUsers(
        buildUpdateMessage(trade, contractPrice, stock.price)
      );

      await new Promise(resolve =>
        setTimeout(resolve, 500)
      );
    } catch (err) {
      console.error(
        `Update trade error ${trade.symbol}:`,
        err.response?.data || err.message
      );
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

البوت يراقب الأسهم الأمريكية عالية السيولة ويبحث عن دخول سيولة قوي في عقود الأوبشن.

لتفعيل اشتراكك:
أرسل كود التفعيل مباشرة مثل:

ST-ABCD-1234

الأوامر:
/mysub حالة الاشتراك
/myid معرفة رقم حسابك

تنبيه:
البوت أداة قراءة سيولة وليست توصية شراء أو بيع.`
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
      return bot.sendMessage(
        msg.chat.id,
        '❌ لا يوجد اشتراك فعال.'
      );
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
    console.error(err);

    await bot.sendMessage(
      msg.chat.id,
      'حدث خطأ أثناء فحص الاشتراك.'
    );
  }
});

bot.onText(/\/create (\d+)/, async (msg, match) => {
  try {
    if (!isAdmin(msg)) {
      return bot.sendMessage(
        msg.chat.id,
        '🚫 هذا الأمر للإدارة فقط'
      );
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
${formatDate(result.expiresAt)}

أرسل هذا الكود للمشترك ليقوم بتفعيله داخل البوت.`
    );
  } catch (err) {
    console.error(err);

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
    return bot.sendMessage(
      msg.chat.id,
      `خطأ:\n${error.message}`
    );
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

  await bot.sendMessage(
    msg.chat.id,
    '🔎 بدأ فحص سهم واحد الآن...'
  );

  await scanNextSymbol();

  await bot.sendMessage(
    msg.chat.id,
    '✅ انتهى الفحص.'
  );
});

bot.onText(/\/open/, async (msg) => {
  if (!isAdmin(msg)) return;

  const trades = await getOpenTrades();

  if (!trades.length) {
    return bot.sendMessage(
      msg.chat.id,
      'لا توجد صفقات مفتوحة.'
    );
  }

  const text = trades.map(t =>
`📊 ${t.symbol} ${sideArabic(t.side)}
🎯 ${t.strike}
📅 ${t.expiration}
💰 الدخول: ${fmtPrice(t.entry_contract_price)}
🛑 الوقف: ${fmtPrice(t.stock_stop_price)}
🎯 الهدف: ${fmtPrice(t.stock_target_1)}`
  ).join('\n\n');

  await bot.sendMessage(msg.chat.id, text);
});

// =====================
// Activation Code Handler
// =====================

bot.on('message', async (msg) => {
  const text = String(msg.text || '').trim();

  if (!text) return;
  if (text.startsWith('/')) return;

  const isActivationCode =
    /^ST-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(text);

  if (!isActivationCode) return;

  try {
    const result = await redeemCode(msg, text);

    await bot.sendMessage(
      msg.chat.id,
      result.message
    );
  } catch (err) {
    console.error(err);

    await bot.sendMessage(
      msg.chat.id,
      '❌ حدث خطأ أثناء تفعيل الكود.'
    );
  }
});

// =====================
// Intervals
// =====================

setInterval(scanNextSymbol, SCAN_INTERVAL_MS);
setInterval(updateOpenTrades, UPDATE_INTERVAL_MS);

console.log('🎯 ST Liquidity Hunter Bot Started');
