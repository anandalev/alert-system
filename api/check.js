// alert-system api/check.js
// Version: 2.2
// Runs every 5 minutes (Vercel Cron, see vercel.json).
// For each enabled coin in alerts.json it places 2 Twilio voice calls when the price crosses DOWN
// through a level. Levels are: threshold, threshold - delta, threshold - 2*delta, ... (always above 0).
// Each level alerts at most once per cooldownHours. The last price and the last alert time of each
// level are kept in one JSON file in a private Vercel Blob store (the store is connected to the project,
// so Vercel adds BLOB_READ_WRITE_TOKEN and BLOB_STORE_ID automatically).
// A coin may have an optional "seedPrice" in alerts.json: it is used as the previous price only
// while no saved price exists yet.
//
// Required env vars:
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

// Levels that the price crossed downward since the previous check.
function crossedLevels(coin, prev, price) {
  const out = [];
  for (let n = 0; coin.threshold - n * coin.delta > 0 && n < 2000; n++) {
    const level = coin.threshold - n * coin.delta;
    if (prev >= level && price < level) out.push(level);
  }
  return out;
}

function fmt(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function escapeXml(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function placeCall(text) {
  const say = escapeXml(text);
  const twiml = '<Response><Say voice="alice">Crypto alert. ' + say + '</Say><Pause length="1"/><Say voice="alice">' + say + '</Say></Response>';
  const res = await fetch(API + process.env.TWILIO_ACCOUNT_SID + '/Calls.json', {
    method: 'POST',
    headers: formHeaders(),
    body: new URLSearchParams({
      To: process.env.ALERT_TO_NUMBER,
      From: process.env.TWILIO_FROM_NUMBER,
      Twiml: twiml
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
    const report = [];

    for (const coin of coins) {
      const price = prices[coin.id] && prices[coin.id].usd;
      if (typeof price !== 'number') { report.push({ coin: coin.symbol, error: 'no price' }); continue; }
      const st = holder.data.coins[coin.id] || { lastPrice: null, levels: {} };
      const prev = typeof st.lastPrice === 'number' ? st.lastPrice : (typeof coin.seedPrice === 'number' ? coin.seedPrice : null);
      const crossed = prev !== null ? crossedLevels(coin, prev, price) : [];
      const eligible = crossed.filter(function (l) { return !(st.levels[l] && now - st.levels[l] < cooldownMs); });

      if (eligible.length) {
        const lowest = Math.min.apply(null, eligible);
        alerts.push({ text: coin.name + ' dropped below ' + fmt(lowest) + ' dollars. Now ' + fmt(price) + '.', coin: coin.symbol, levels: eligible });
        eligible.forEach(function (l) { st.levels[l] = now; });
      }
      Object.keys(st.levels).forEach(function (l) { if (now - st.levels[l] > 48 * 3600 * 1000) delete st.levels[l]; });
      st.lastPrice = price;
      holder.data.coins[coin.id] = st;
      report.push({ coin: coin.symbol, price: price, crossed: crossed, alerted: eligible });
    }

    if (dry) return res.status(200).json({ ok: true, dry: true, report: report, wouldCall: alerts.map(function (a) { return a.text; }) });

    if (!alerts.length) {
      await saveState(holder);
      return res.status(200).json({ ok: true, report: report });
    }

    // Alert: first call, then save state (so a retry cannot repeat the alert), then the remaining calls.
    const text = alerts.map(function (a) { return a.text; }).join(' ');
    let sid = await placeCall(text);
    await saveState(holder);
    for (let i = 1; i < calls; i++) {
      await waitForCall(sid);
      await sleep(3000);
      sid = await placeCall(text);
    }
    return res.status(200).json({ ok: true, called: calls, report: report });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
