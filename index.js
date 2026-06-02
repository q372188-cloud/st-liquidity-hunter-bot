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

    <div class="channel">مدرسة السوق الأمريكي</div>

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
  if (processingSymbols.has(symbol)) return;

  processingSymbols.add(symbol);

  try {
    const pair = await getLatestPair(symbol);

    if (!pair) {
      console.log('NO PAIR FOUND:', symbol);
      return;
    }

    if (pair.radar.processed && pair.gamma.processed) {
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
        caption: `📡 رادار السوق — ${symbol}\nمدرسة السوق الأمريكي`
      }
    );

    await markProcessed([pair.radar.id, pair.gamma.id]);

    fs.unlinkSync(imagePath);

    console.log('IMAGE SENT:', symbol);
  } catch (err) {
    console.error('PROCESS SYMBOL ERROR:', symbol, err.message);
  } finally {
    processingSymbols.delete(symbol);
  }
}

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

bot.onText(/^\/myid$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
`chat.id:
${msg.chat.id}

from.id:
${msg.from.id}`
  );
});

bot.onText(/^\/start$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    '✅ بوت الصور يعمل.\nأرسل /test TSLA لاختبار آخر بيانات محفوظة.'
  );
});

bot.onText(/^\/test\s+([A-Z]{1,6})$/i, async (msg, match) => {
  const symbol = String(match[1]).toUpperCase();

  await bot.sendMessage(
    msg.chat.id,
    `⏳ جاري إنشاء صورة ${symbol}...`
  );

  await processSymbol(symbol, msg.chat.id);
});

setInterval(scanSnapshots, CHECK_INTERVAL_MS);

scanSnapshots();

console.log('🖼️ ST Image Bot Started');
