require('dotenv').config();

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 }
  }
});

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const imageSupabase = createClient(
  process.env.IMAGE_SUPABASE_URL,
  process.env.IMAGE_SUPABASE_KEY
);

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 30 * 1000);
const PAIR_WINDOW_MINUTES = Number(process.env.PAIR_WINDOW_MINUTES || 20);

const processingSymbols = new Set();

const userMode = {};
const SERVICE_IMAGE = 'image';

function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🖼 صورة القاما + السيولة', callback_data: 'image_service' }]
      ]
    }
  };
}

function normalizeSymbol(v) {
  return String(v || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 10);
}

async function hasServiceAccess(userId, service) {
  const { data, error } = await imageSupabase
    .from('service_subscriptions')
    .select('id')
    .eq('user_id', String(userId))
    .eq('service', service)
    .eq('active', true)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error) {
    console.error('ACCESS CHECK ERROR:', error.message);
    return false;
  }

  return !!data;
}

async function activateServiceCode(userId, code, service, fromUser = {}) {
  const nowIso = new Date().toISOString();

  const username = fromUser.username || null;
  const firstName = fromUser.first_name || null;

  const { data: codeRow, error: codeError } = await imageSupabase
    .from('service_codes')
    .select('*')
    .eq('code', String(code).trim().toUpperCase())
    .eq('service', service)
    .eq('active', true)
    .is('used_by', null)
    .gt('expires_at', nowIso)
    .maybeSingle();

  if (codeError) {
    console.error('CODE CHECK ERROR:', codeError.message);
    return { ok: false, message: 'حدث خطأ أثناء التحقق من الكود.' };
  }

  if (!codeRow) {
    return { ok: false, message: '❌ الكود غير صحيح أو مستخدم أو منتهي.' };
  }

  const { error: upsertError } = await imageSupabase
    .from('service_subscriptions')
    .upsert({
      user_id: String(userId),
      username,
      first_name: firstName,
      service,
      active: true,
      expires_at: codeRow.expires_at
    }, {
      onConflict: 'user_id,service'
    });

  if (upsertError) {
    console.error('SUBSCRIPTION UPSERT ERROR:', upsertError.message);
    return { ok: false, message: 'حدث خطأ أثناء تفعيل الاشتراك.' };
  }

  const { error: updateCodeError } = await imageSupabase
    .from('service_codes')
    .update({
      active: false,
      used_by: String(userId),
      used_at: nowIso
    })
    .eq('id', codeRow.id);

  if (updateCodeError) {
    console.error('CODE UPDATE ERROR:', updateCodeError.message);
  }

  return { ok: true, message: '✅ تم تفعيل اشتراك الصور بنجاح.\nاكتب رمز الشركة الآن مثل: TSLA' };
}

function stripBadEmojis(v) {
  return String(v || '')
    .replace(/[🟢🔴🟡⚪✅❌⚠️🚀📡📊📈📉🔥💰🧠🎯🛑👑]/g, '')
    .trim();
}

function clean(v) {
  return stripBadEmojis(v);
}

function extract(regex, text, fallback = 'N/A') {
  const m = String(text || '').match(regex);
  return m ? clean(m[1]) : fallback;
}

function parseRadar(text) {
  return {
    price: extract(/سعر السهم الحالي:\s*([0-9.]+)/, text),
    change: extract(/التغير:\s*([+\-]?[0-9.]+%)/, text),
    trend: extract(/الاتجاه:\s*([^\n]+)/, text),
    flowBias: extract(/اتجاه تدفق العقود\s*\n([^\n]+)/, text),
    gammaExposure: extract(/Gamma Exposure:\s*([+\-]?[0-9.,KMB]+)/, text),
    deltaExposure: extract(/Delta Exposure:\s*([+\-]?[0-9.,KMB]+)/, text),
    askFlow: extract(/Ask Flow:\s*([0-9.]+%)/, text),
    bidFlow: extract(/Bid Flow:\s*([0-9.]+%)/, text),
    controller: extract(/الطرف المسيطر:\s*([^\n]+)/, text),
    strength: extract(/قوة السيطرة:\s*([0-9.]+\s*\/\s*10)/, text)
  };
}

function parseGamma(text) {
  return {
    price: extract(/السعر الحالي:\s*([0-9.]+)/, text),
    direction: extract(/الاتجاه:\s*([^\n]+)/, text),
    confidence: extract(/الثقة:\s*([0-9.]+\s*\/\s*10)/, text),
    entry: extract(/الدخول:\s*\n([^\n]+)/, text),
    tp1: extract(/TP1:\s*([^\n]+)/, text),
    tp2: extract(/TP2:\s*([^\n]+)/, text),
    tp3: extract(/TP3:\s*([^\n]+)/, text),
    stop: extract(/الوقف الفني:\s*\n([^\n]+)/, text),
    gammaRegime: extract(/Gamma Regime:\s*\n([^\n]+)/, text),
    gammaFlip: extract(/Gamma Flip:\s*\n([^\n]+)/, text),
    dex: extract(/DEX:\s*\n([^\n]+)/, text),
    callFlow: extract(/Call Flow:\s*([+\-]?[0-9.]+%)/, text),
    putFlow: extract(/Put Flow:\s*([+\-]?[0-9.]+%)/, text),
    r1: extract(/R1️⃣\s*([0-9.]+)/, text),
    r2: extract(/R2️⃣\s*([0-9.]+)/, text),
    r3: extract(/R3️⃣\s*([0-9.]+)/, text),
    s1: extract(/S1️⃣\s*([0-9.]+)/, text),
    s2: extract(/S2️⃣\s*([0-9.]+)/, text),
    s3: extract(/S3️⃣\s*([0-9.]+)/, text)
  };
}

function getDecisionColor(decision) {
  const d = String(decision || '').toUpperCase();

  if (d.includes('CALL')) return '#5ee25e';
  if (d.includes('PUT')) return '#ff4d4d';

  return '#f2c94c';
}

function buildHtml({ symbol, radar, gamma }) {
  const decisionColor = getDecisionColor(gamma.direction);

  return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />

<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&family=Noto+Kufi+Arabic:wght@400;700;900&display=swap" rel="stylesheet">

<style>
  * {
    box-sizing: border-box;
    font-family: 'Cairo', 'Noto Kufi Arabic', Tahoma, Arial, sans-serif;
  }

  body {
    margin: 0;
    width: 1200px;
    min-height: 1300px;
    background: #07111c;
    color: #ffffff;
    direction: rtl;
    font-family: 'Cairo', 'Noto Kufi Arabic', Tahoma, Arial, sans-serif;
  }

  .wrap {
    padding: 26px;
    background:
      radial-gradient(circle at top right, rgba(0, 153, 255, .22), transparent 32%),
      radial-gradient(circle at bottom left, rgba(0, 255, 120, .12), transparent 30%),
      #07111c;
  }

  .header {
    display: grid;
    grid-template-columns: 1fr 2fr 1fr;
    gap: 18px;
    align-items: center;
    padding: 18px 24px;
    border: 1px solid #284057;
    border-radius: 22px;
    background: linear-gradient(180deg, #101e2b, #08131e);
  }

  .channel {
    font-size: 40px;
    font-weight: 900;
    text-align: center;
    color: #ffffff;
  }

  .brand {
    text-align: right;
    font-size: 22px;
    color: #8fc9ff;
  }

  .symbol {
    font-size: 54px;
    font-weight: 900;
    direction: ltr;
    text-align: right;
  }

  .radar-title {
    font-size: 28px;
    color: #54baff;
    text-align: left;
  }

  .top-cards {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin-top: 18px;
  }

  .card {
    background: rgba(13, 29, 43, .92);
    border: 1px solid #294158;
    border-radius: 18px;
    padding: 18px;
    min-height: 110px;
  }

  .label {
    color: #9fb6c9;
    font-size: 21px;
    margin-bottom: 8px;
  }

  .value {
    font-size: 30px;
    font-weight: 900;
  }

  .green { color: #67e36f; }
  .red { color: #ff5757; }
  .yellow { color: #f2c94c; }
  .blue { color: #61c4ff; }

  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
    margin-top: 18px;
  }

  .section-title {
    font-size: 28px;
    font-weight: 900;
    margin-bottom: 14px;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid rgba(255,255,255,.12);
    padding: 12px 0;
    font-size: 24px;
    gap: 18px;
  }

  .row:last-child {
    border-bottom: none;
  }

  .row b {
    direction: ltr;
    text-align: left;
  }

  .big-decision {
    border: 2px solid ${decisionColor};
    box-shadow: 0 0 22px rgba(100,255,100,.14);
    text-align: center;
  }

  .decision {
    font-size: 43px;
    font-weight: 900;
    color: ${decisionColor};
    margin: 8px 0;
    direction: ltr;
  }

  .targets {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-top: 12px;
  }

  .target {
    border: 1px solid #31506b;
    border-radius: 14px;
    padding: 14px;
    text-align: center;
    background: rgba(0,0,0,.18);
  }

  .target b {
    display: block;
    color: #8fc9ff;
    font-size: 20px;
    margin-bottom: 8px;
  }

  .target span {
    font-size: 27px;
    font-weight: 900;
  }

  .levels {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }

  .level-box {
    border-radius: 16px;
    padding: 16px;
    background: rgba(0,0,0,.18);
    border: 1px solid #31506b;
  }

  .level-line {
    display: flex;
    justify-content: space-between;
    padding: 11px 0;
    font-size: 25px;
    border-bottom: 1px solid rgba(255,255,255,.1);
  }

  .level-line:last-child {
    border-bottom: none;
  }

  .summary {
    font-size: 25px;
    line-height: 1.75;
    color: #e8f4ff;
  }

  .footer {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 14px;
    margin-top: 18px;
  }

  .note {
    text-align: center;
    font-size: 22px;
    color: #f2c94c;
    padding: 16px;
    border: 1px solid #514627;
    border-radius: 16px;
    background: rgba(255, 196, 0, .08);
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="header">
    <div>
      <div class="symbol">${symbol}</div>
      <div class="brand">تحليل السيولة والقاما</div>
    </div>

    <div class="channel">مدرسة السوق الامريكي</div>

    <div class="radar-title">رادار السوق</div>
  </div>

  <div class="top-cards">
    <div class="card">
      <div class="label">السعر الحالي</div>
      <div class="value">${gamma.price !== 'N/A' ? gamma.price : radar.price}</div>
    </div>

    <div class="card">
      <div class="label">تغير الرادار</div>
      <div class="value ${String(radar.change).includes('-') ? 'red' : 'green'}">${radar.change}</div>
    </div>

    <div class="card">
      <div class="label">اتجاه الرادار</div>
      <div class="value">${radar.trend}</div>
    </div>

    <div class="card big-decision">
      <div class="label">القرار النهائي</div>
      <div class="decision">${gamma.direction}</div>
    </div>
  </div>

  <div class="grid2">
    <div class="card">
      <div class="section-title red">الإشارات السلبية</div>

      <div class="row">
        <span>Bid Flow</span>
        <b class="red">${radar.bidFlow}</b>
      </div>

      <div class="row">
        <span>Put Flow</span>
        <b class="red">${gamma.putFlow}</b>
      </div>

      <div class="row">
        <span>الوقف الفني</span>
        <b class="red">${gamma.stop}</b>
      </div>

      <div class="row">
        <span>دعم قريب</span>
        <b class="red">${gamma.s1}</b>
      </div>
    </div>

    <div class="card">
      <div class="section-title green">الإشارات الإيجابية</div>

      <div class="row">
        <span>Call Flow</span>
        <b class="green">${gamma.callFlow}</b>
      </div>

      <div class="row">
        <span>Ask Flow</span>
        <b class="green">${radar.askFlow}</b>
      </div>

      <div class="row">
        <span>Gamma Regime</span>
        <b class="green">${gamma.gammaRegime}</b>
      </div>

      <div class="row">
        <span>DEX</span>
        <b class="green">${gamma.dex}</b>
      </div>
    </div>
  </div>

  <div class="grid2">
    <div class="card">
      <div class="section-title blue">تدفق السيولة</div>

      <div class="row">
        <span>اتجاه العقود</span>
        <b>${radar.flowBias}</b>
      </div>

      <div class="row">
        <span>Call Flow</span>
        <b class="green">${gamma.callFlow}</b>
      </div>

      <div class="row">
        <span>Put Flow</span>
        <b class="red">${gamma.putFlow}</b>
      </div>

      <div class="row">
        <span>Ask / Bid</span>
        <b>${radar.askFlow} / ${radar.bidFlow}</b>
      </div>

      <div class="row">
        <span>الطرف المسيطر</span>
        <b>${radar.controller}</b>
      </div>

      <div class="row">
        <span>قوة السيطرة</span>
        <b>${radar.strength}</b>
      </div>
    </div>

    <div class="card">
      <div class="section-title yellow">القاما والدلتا</div>

      <div class="row">
        <span>Gamma Exposure</span>
        <b>${radar.gammaExposure}</b>
      </div>

      <div class="row">
        <span>Delta Exposure</span>
        <b>${radar.deltaExposure}</b>
      </div>

      <div class="row">
        <span>Gamma Flip</span>
        <b>${gamma.gammaFlip}</b>
      </div>

      <div class="row">
        <span>Gamma Regime</span>
        <b>${gamma.gammaRegime}</b>
      </div>

      <div class="row">
        <span>DEX</span>
        <b>${gamma.dex}</b>
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:18px;">
    <div class="section-title green">خطة المتابعة</div>

    <div class="row">
      <span>الدخول</span>
      <b>${gamma.entry}</b>
    </div>

    <div class="targets">
      <div class="target">
        <b>TP1</b>
        <span>${gamma.tp1}</span>
      </div>

      <div class="target">
        <b>TP2</b>
        <span>${gamma.tp2}</span>
      </div>

      <div class="target">
        <b>TP3</b>
        <span>${gamma.tp3}</span>
      </div>

      <div class="target">
        <b>STOP</b>
        <span class="red">${gamma.stop}</span>
      </div>
    </div>
  </div>

  <div class="grid2">
    <div class="card">
      <div class="section-title green">مقاومات القاما</div>

      <div class="levels">
        <div class="level-box">
          <div class="level-line">
            <span>R1</span>
            <b>${gamma.r1}</b>
          </div>

          <div class="level-line">
            <span>R2</span>
            <b>${gamma.r2}</b>
          </div>

          <div class="level-line">
            <span>R3</span>
            <b>${gamma.r3}</b>
          </div>
        </div>

        <div class="level-box">
          <div class="level-line">
            <span>Gamma Flip</span>
            <b>${gamma.gammaFlip}</b>
          </div>

          <div class="level-line">
            <span>السعر</span>
            <b>${gamma.price}</b>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="section-title red">مستويات قاما سفلية</div>

      <div class="levels">
        <div class="level-box">
          <div class="level-line">
            <span>S1</span>
            <b>${gamma.s1}</b>
          </div>

          <div class="level-line">
            <span>S2</span>
            <b>${gamma.s2}</b>
          </div>

          <div class="level-line">
            <span>S3</span>
            <b>${gamma.s3}</b>
          </div>
        </div>

        <div class="level-box">
          <div class="level-line">
            <span>الثقة</span>
            <b>${gamma.confidence}</b>
          </div>

          <div class="level-line">
            <span>النطاق</span>
            <b>${gamma.s1} ➜ ${gamma.r1}</b>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:18px;">
    <div class="section-title blue">الخلاصة النهائية</div>

    <div class="summary">
      القرار الحالي على ${symbol}: <b style="color:${decisionColor}">${gamma.direction}</b>
      بدرجة ثقة <b>${gamma.confidence}</b>.
      الرادار يظهر أن تدفق العقود: <b>${radar.flowBias}</b>،
      والطرف المسيطر: <b>${radar.controller}</b>.
      المتابعة تكون عند: <b>${gamma.entry}</b>،
      مع مراقبة المقاومة <b>${gamma.r1}</b> والدعم <b>${gamma.s1}</b>.
    </div>
  </div>

  <div class="footer">
    <div class="note">ليست توصية شراء أو بيع</div>
    <div class="note">محتوى تعليمي وتحليلي فقط</div>
    <div class="note">يتم التحديث حسب بيانات الرادار والقاما</div>
  </div>

</div>
</body>
</html>
`;
}

async function getLatestPair(symbol) {
  const since = new Date(Date.now() - PAIR_WINDOW_MINUTES * 60 * 1000).toISOString();

  const { data, error } = await imageSupabase
    .from('image_snapshots')
    .select('*')
    .eq('symbol', symbol)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw error;

  const radar = (data || []).find(x => x.source === 'radar');
  const gamma = (data || []).find(x => x.source === 'gamma' || x.source === 'gamma_auto');

  if (!radar || !gamma) return null;

  return { radar, gamma };
}

async function markProcessed(ids) {
  await imageSupabase
    .from('image_snapshots')
    .update({ processed: true })
    .in('id', ids);
}

async function generateImage(symbol, radarText, gammaText) {
  const radar = parseRadar(radarText);
  const gamma = parseGamma(gammaText);

  const html = buildHtml({ symbol, radar, gamma });

  const outDir = path.join(__dirname, 'tmp');

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir);
  }

  const filePath = path.join(outDir, `radar-${symbol}-${Date.now()}.png`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const page = await browser.newPage();

  await page.setViewport({
    width: 1200,
    height: 1300,
    deviceScaleFactor: 1
  });

  await page.setJavaScriptEnabled(true);

  await page.setContent(html, {
    waitUntil: 'networkidle0'
  });

  await page.evaluateHandle('document.fonts.ready');

  await page.screenshot({
    path: filePath,
    fullPage: true
  });

  await browser.close();

  return filePath;
}

async function processSymbol(symbol, targetChatId = ADMIN_CHAT_ID) {
  const isManualRequest = String(targetChatId) !== String(ADMIN_CHAT_ID);
  const lockKey = `${symbol}:${targetChatId}`;

  if (processingSymbols.has(lockKey)) return;

  processingSymbols.add(lockKey);

  try {
    const pair = await getLatestPair(symbol);

    if (!pair) {
      console.log('NO PAIR FOUND:', symbol);

      if (isManualRequest) {
        await bot.sendMessage(
          targetChatId,
          `❌ لا توجد بيانات قاما وسيولة مكتملة لـ ${symbol} خلال آخر ${PAIR_WINDOW_MINUTES} دقيقة.`
        );
      }

      return;
    }

    if (!isManualRequest && pair.radar.processed && pair.gamma.processed) {
      console.log('PAIR ALREADY PROCESSED:', symbol);
      return;
    }

    const imagePath = await generateImage(
      symbol,
      pair.radar.message_text,
      pair.gamma.message_text
    );

    await bot.sendPhoto(
      targetChatId,
      fs.createReadStream(imagePath),
      {
        caption: `📡 رادار مدرسة السوق الامريكي — ${symbol}`
      }
    );

    if (!isManualRequest) {
      await markProcessed([pair.radar.id, pair.gamma.id]);
    }

    fs.unlinkSync(imagePath);

    console.log('IMAGE SENT:', symbol);
  } catch (err) {
    console.error('PROCESS SYMBOL ERROR:', symbol, err.message);

    if (isManualRequest) {
      await bot.sendMessage(targetChatId, 'حدث خطأ أثناء تجهيز الصورة. حاول مرة أخرى.');
    }
  } finally {
    processingSymbols.delete(lockKey);
  }
}

function makeCode(service = 'IMAGE') {
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${service}-${random}`;
}

function parseDurationDays(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

bot.onText(/\/createimagecode(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (String(chatId) !== String(ADMIN_CHAT_ID)) {
    return bot.sendMessage(chatId, '❌ هذا الأمر للأدمن فقط.');
  }

  const days = parseDurationDays(match[1] || 30);

  if (!days) {
    return bot.sendMessage(chatId, 'استخدم الأمر بهذا الشكل:\n/createimagecode 30');
  }

  const code = makeCode('IMAGE');
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await imageSupabase
    .from('service_codes')
    .insert({
      code,
      service: SERVICE_IMAGE,
      active: true,
      expires_at: expiresAt
    });

  if (error) {
    console.error('CREATE IMAGE CODE ERROR:', error.message);
    return bot.sendMessage(chatId, 'حدث خطأ أثناء إنشاء الكود.');
  }

  return bot.sendMessage(
    chatId,
    `✅ تم إنشاء كود الصور\n\n` +
    `🔐 الكود: \`${code}\`\n` +
    `⏳ المدة: ${days} يوم\n` +
    `📌 الخدمة: الصور`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(
    chatId,
    'أهلًا بك في خدمة صور القاما والسيولة.\nاختر الخدمة:',
    mainMenu()
  );
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;

  await bot.answerCallbackQuery(query.id);

  if (query.data === 'image_service') {
    const ok = await hasServiceAccess(chatId, SERVICE_IMAGE);

    if (!ok) {
      userMode[chatId] = 'activate_image';
      return bot.sendMessage(chatId, '🔐 أدخل كود اشتراك الصور:');
    }

    userMode[chatId] = 'image_symbol';
    return bot.sendMessage(chatId, '🖼 اكتب رمز الشركة مثل: TSLA');
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();

  if (!text || text.startsWith('/')) return;

  const mode = userMode[chatId];

  if (mode === 'activate_image') {
    const result = await activateServiceCode(
      chatId,
      text,
      SERVICE_IMAGE,
      msg.from || {}
    );

    await bot.sendMessage(chatId, result.message);

    if (result.ok) {
      userMode[chatId] = 'image_symbol';
    }

    return;
  }

  if (mode === 'image_symbol') {
    const symbol = normalizeSymbol(text);

    if (!symbol) {
      return bot.sendMessage(chatId, 'اكتب رمز صحيح مثل: TSLA');
    }

    const ok = await hasServiceAccess(chatId, SERVICE_IMAGE);

    if (!ok) {
      userMode[chatId] = 'activate_image';
      return bot.sendMessage(chatId, '🔐 اشتراك الصور غير مفعل أو منتهي.\nأدخل كود اشتراك الصور:');
    }

    await bot.sendMessage(chatId, `⏳ جاري تجهيز صورة ${symbol}...`);

    await processSymbol(symbol, chatId);

    return;
  }
});

async function scanSnapshots() {
  try {
    const since = new Date(Date.now() - PAIR_WINDOW_MINUTES * 60 * 1000).toISOString();

    const { data, error } = await imageSupabase
      .from('image_snapshots')
      .select('symbol')
      .eq('processed', false)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const symbols = [
      ...new Set(
        (data || [])
          .map(x => x.symbol)
          .filter(Boolean)
      )
    ];

    for (const symbol of symbols) {
      await processSymbol(symbol);
    }
  } catch (err) {
    console.error('SCAN ERROR:', err.message);
  }
}

setInterval(scanSnapshots, CHECK_INTERVAL_MS);

scanSnapshots();

console.log('🖼️ ST Image Bot Started');
