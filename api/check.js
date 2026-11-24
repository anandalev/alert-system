// alert-system api/check.js
// Version: 2.9
// Runs every 5 minutes (Vercel Cron, see vercel.json).
// For each enabled coin in alerts.json it places 2 Twilio voice calls when the price crosses DOWN
// through a level. Levels are: threshold, threshold - delta, threshold - 2*delta, ... (always above 0).
// Each level alerts at most once per cooldownHours. The last price and the last alert time of each
// level are kept in one JSON file in a private Vercel Blob store (the store is connected to the project,
// so Vercel adds BLOB_READ_WRITE_TOKEN and BLOB_STORE_ID automatically).
// A coin may have an optional "seedPrice" in alerts.json: it is used as the previous price only
// while no saved price exists yet (set it to the threshold so a coin already below it alerts on its
// first run). Levels are rounded to the decimals of delta, so 0.95 - 0.05 is exactly 0.90.
//
// Every alert also sends one email through MailerSend to settings.alertEmail, with coin, level,
// price and the previous time that level was crossed (NONE if never). The email is best effort:
// if it fails, the calls still go out.
//
// Required env vars:
//   MAILERSEND_API_KEY, MAILERSEND_FROM (an address on a domain verified in MailerSend),
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, ALERT_TO_NUMBER, CRON_SECRET
// Add ?dry=1 to the URL to evaluate without placing calls or saving state.

const config = require('../alerts.json');
const { put, get } = require('@vercel/blob');

const STATE_FILE = 'alert-state.json';
const API = 'https://api.twilio.com/2010-04-01/Accounts/';

function authHeader() {
  const token = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
  return { Authorization: 'Basic ' + token };
}

function formHeaders() {
  return Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, authHeader());
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function getPrices(ids) {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
    encodeURIComponent(ids.join(',')) + '&vs_currencies=usd';
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('Price API error ' + res.status);
  return res.json();
}

async function loadState() {
  const result = await get(STATE_FILE, { access: 'private', useCache: false });
  if (!result || result.statusCode !== 200) return { data: { coins: {} } };
  const data = await new Response(result.stream).json();
  return { data: data && data.coins ? data : { coins: {} } };
}

async function saveState(holder) {
  await put(STATE_FILE, JSON.stringify(holder.data), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json'
  });
}

function decimalsOf(n) {
  const t = String(n);
  return t.indexOf('.') === -1 ? 0 : t.length - t.indexOf('.') - 1;
}

function roundTo(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// Highest level below the current price that is not in its cooldown window, so it can trigger the
// next alert. Returns null when no level above 0 is left.
function nextAlertLevel(coin, st, price, now, cooldownMs) {
  const d = decimalsOf(coin.delta);
  for (let n = 0; n < 2000; n++) {
    const level = roundTo(coin.threshold - n * coin.delta, d);
    if (level <= 0) return null;
    if (level >= price) continue;
    if (st.levels[level] && now - st.levels[level] < cooldownMs) continue;
    return level;
  }
  return null;
}

// Levels that the price crossed downward since the previous check.
function crossedLevels(coin, prev, price) {
  const out = [];
  for (let n = 0; coin.threshold - n * coin.delta > 0 && n < 2000; n++) {
    const level = roundTo(coin.threshold - n * coin.delta, decimalsOf(coin.delta));
    if (prev >= level && price < level) out.push(level);
  }
  return out;
}

function fmt(n, decimals) {
  const d = typeof decimals === 'number' ? decimals : 0;
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// Price display: whole dollars above 1,000, otherwise enough decimals to be useful.
function fmtPrice(n) {
  const a = Math.abs(n);
  return fmt(n, a >= 1000 ? 0 : a >= 10 ? 2 : 4);
}

function baseUrl() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || 'alert-system-iota.vercel.app';
  return 'https://' + host;
}

async function placeCall(text) {
  const res = await fetch(API + process.env.TWILIO_ACCOUNT_SID + '/Calls.json', {
    method: 'POST',
    headers: formHeaders(),
    body: new URLSearchParams({
      To: process.env.ALERT_TO_NUMBER,
      From: process.env.TWILIO_FROM_NUMBER,
      Url: baseUrl() + '/api/twiml?text=' + encodeURIComponent(text)
    }).toString()
  });
  if (!res.ok) throw new Error('Twilio call error ' + res.status + ' ' + (await res.text()));
  return (await res.json()).sid;
}

// Wait (up to about 50 seconds) until the call has ended, so the second call does not collide with the first.
async function waitForCall(callSid) {
  const done = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];
  for (let i = 0; i < 12; i++) {
    await sleep(4000);
    const res = await fetch(API + process.env.TWILIO_ACCOUNT_SID + '/Calls/' + callSid + '.json', { headers: authHeader() });
    if (!res.ok) return;
    const body = await res.json();
    if (done.indexOf(body.status) !== -1) return;
  }
}

function israelTime(ms) {
  return new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', dateStyle: 'medium', timeStyle: 'short' }) + ' (Israel)';
}

async function sendEmail(items, current, now) {
  const key = process.env.MAILERSEND_API_KEY;
  const from = process.env.MAILERSEND_FROM;
  const to = config.settings.alertEmail;
  if (!key || !from || !to) return 'skipped: missing MAILERSEND_API_KEY, MAILERSEND_FROM or alertEmail';
  const subject = items.map(function (i) { return i.symbol + ' crossed below ' + i.level; }).join(', ');
  const lines = items.map(function (i) {
    return [
      'Coin: ' + i.name + ' (' + i.symbol + ')',
      'Level crossed: ' + i.level + ' USD',
      'Current price: ' + i.price + ' USD',
      'Next alert level: ' + i.next,
      'Crossed at: ' + israelTime(now),
      'Last time this level was crossed: ' + (i.previous ? israelTime(i.previous) : 'NONE')
    ].join('\n');
  });
  const priceLines = current.map(function (c) { return c.symbol + ': ' + c.price + ' USD'; });
  const sections = ['ALERTS'].concat(lines).concat(['CURRENT PRICES\n' + priceLines.join('\n')]);
  const text = sections.join('\n\n');
  const esc = function (t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px">' +
    '<h3 style="margin:0 0 8px">Alerts</h3>' +
    lines.map(function (l) { return '<p>' + esc(l).split('\n').join('<br>') + '</p>'; }).join('') +
    '<h3 style="margin:16px 0 8px">Current prices</h3>' +
    '<p>' + priceLines.map(esc).join('<br>') + '</p></div>';
  const res = await fetch('https://api.mailersend.com/v1/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      from: { email: from, name: 'Crypto Alerts' },
      to: [{ email: to }],
      subject: 'Crypto alert: ' + subject,
      text: text,
      html: html
    })
  });
  if (!res.ok) throw new Error('MailerSend error ' + res.status + ' ' + (await res.text()));
  return 'sent';
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET is not set' });
  if (req.headers.authorization !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

  const dry = req.query && req.query.dry === '1';
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'ALERT_TO_NUMBER'];
  const missing = required.filter(function (k) { return !process.env[k]; });
  if (missing.length) return res.status(500).json({ error: 'missing env vars', missing: missing });

  try {
    const cooldownMs = (config.settings.cooldownHours || 8) * 3600 * 1000;
    const calls = config.settings.callsPerAlert || 2;
    const coins = config.coins.filter(function (c) {
      return c.enabled && typeof c.threshold === 'number' && typeof c.delta === 'number' && c.delta > 0;
    });
    if (!coins.length) return res.status(200).json({ ok: true, checked: 0 });

    const prices = await getPrices(coins.map(function (c) { return c.id; }));
    const holder = await loadState();
    const now = Date.now();
    const alerts = [];
    const emailItems = [];
    const current = [];
    const report = [];

    for (const coin of coins) {
      const price = prices[coin.id] && prices[coin.id].usd;
      if (typeof price !== 'number') { report.push({ coin: coin.symbol, error: 'no price' }); current.push({ symbol: coin.symbol, price: 'unavailable' }); continue; }
      current.push({ symbol: coin.symbol, price: fmtPrice(price) });
      const st = holder.data.coins[coin.id] || { lastPrice: null, levels: {} };
      if (!st.lastCrossed) st.lastCrossed = Object.assign({}, st.levels);
      const prev = typeof st.lastPrice === 'number' ? st.lastPrice : (typeof coin.seedPrice === 'number' ? coin.seedPrice : null);
      const crossed = prev !== null ? crossedLevels(coin, prev, price) : [];
      const eligible = crossed.filter(function (l) { return !(st.levels[l] && now - st.levels[l] < cooldownMs); });

      if (eligible.length) {
        const lowest = Math.min.apply(null, eligible);
        const ld = decimalsOf(coin.delta);
        alerts.push({ text: (coin.spoken || coin.name) + ' dropped below ' + fmt(lowest, ld) + ' dollars. Now ' + fmtPrice(price) + '.', coin: coin.symbol, levels: eligible });
        const previous = {};
        eligible.forEach(function (l) {
          previous[l] = st.lastCrossed[l] || null;
          st.levels[l] = now;
        });
        const next = nextAlertLevel(coin, st, price, now, cooldownMs);
        eligible.forEach(function (l) {
          emailItems.push({ name: coin.name, symbol: coin.symbol, level: fmt(l, ld), price: fmtPrice(price), previous: previous[l], next: next === null ? 'NONE' : fmt(next, ld) + ' USD' });
        });
      }
      crossed.forEach(function (l) { st.lastCrossed[l] = now; });
      Object.keys(st.levels).forEach(function (l) { if (now - st.levels[l] > 48 * 3600 * 1000) delete st.levels[l]; });
      st.lastPrice = price;
      holder.data.coins[coin.id] = st;
      report.push({ coin: coin.symbol, price: price, crossed: crossed, alerted: eligible });
    }

    console.log('[alert-check] ' + (dry ? 'dry ' : '') + JSON.stringify(report));
    if (dry) return res.status(200).json({ ok: true, dry: true, report: report, wouldCall: alerts.map(function (a) { return a.text; }), wouldEmail: emailItems });

    if (!alerts.length) {
      await saveState(holder);
      return res.status(200).json({ ok: true, report: report });
    }

    // Alert: first call, then save state (so a retry cannot repeat the alert), then the remaining calls.
    const text = alerts.map(function (a) { return a.text; }).join(' ');
    let sid = await placeCall(text);
    await saveState(holder);
    let email;
    try {
      email = await sendEmail(emailItems, current, now);
    } catch (e) {
      email = 'failed: ' + String(e.message || e);
      console.error('[alert-check] email ' + email);
    }
    for (let i = 1; i < calls; i++) {
      await waitForCall(sid);
      await sleep(3000);
      sid = await placeCall(text);
    }
    return res.status(200).json({ ok: true, called: calls, email: email, report: report });
  } catch (err) {
    console.error('[alert-check] error ' + String(err.message || err));
    return res.status(500).json({ error: String(err.message || err) });
  }
};
