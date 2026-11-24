// alert-system api/check.js
// Version: 1.1
// Checks crypto prices against alerts.json and places a Twilio voice call that reads the alert.
// Called by Vercel Cron every 5 minutes (see vercel.json).
//
// Required env vars:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, ALERT_TO_NUMBER, CRON_SECRET
// Add ?dry=1 to the URL to evaluate rules without placing a call.
// Cooldown is shared: if any call to ALERT_TO_NUMBER happened within the shortest cooldown
// of the rules that fired, no new call is placed. Rules that fire together share one call.

const config = require('../alerts.json');

async function getPrices(coinIds) {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
    encodeURIComponent(coinIds.join(',')) +
    '&vs_currencies=usd&include_24hr_change=true';
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('Price API error ' + res.status);
  return res.json();
}

function evaluate(rule, data) {
  if (!data) return null;
  const price = data.usd;
  const change = data.usd_24h_change;
  if (rule.type === 'above' && price >= rule.threshold) {
    return rule.symbol + ' is above ' + rule.threshold + ' USD (now ' + price.toFixed(2) + ').';
  }
  if (rule.type === 'below' && price <= rule.threshold) {
    return rule.symbol + ' is below ' + rule.threshold + ' USD (now ' + price.toFixed(2) + ').';
  }
  if (rule.type === 'change24h' && typeof change === 'number' && Math.abs(change) >= rule.threshold) {
    const dir = change > 0 ? 'up' : 'down';
    return rule.symbol + ' is ' + dir + ' ' + Math.abs(change).toFixed(1) + '% in 24h (now ' + price.toFixed(2) + ' USD).';
  }
  return null;
}

function twilioHeaders() {
  const token = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
  return { Authorization: 'Basic ' + token };
}

// Stateless cooldown: look at recent calls already placed through Twilio.
async function recentlyCalled(cooldownMinutes) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const params = new URLSearchParams({
    To: process.env.ALERT_TO_NUMBER,
    From: process.env.TWILIO_FROM_NUMBER,
    PageSize: '50'
  });
  params.set('StartTime>', new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10));
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Calls.json?' + params.toString();
  const res = await fetch(url, { headers: twilioHeaders() });
  if (!res.ok) throw new Error('Twilio history error ' + res.status);
  const body = await res.json();
  const cutoff = Date.now() - cooldownMinutes * 60 * 1000;
  return (body.calls || []).some(function (c) {
    return Date.parse(c.date_created) >= cutoff;
  });
}

function escapeXml(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function placeCall(text) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const twiml = '<Response><Say voice="alice">Crypto alert. ' + escapeXml(text) + '</Say><Pause length="1"/><Say voice="alice">' + escapeXml(text) + '</Say></Response>';
  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Calls.json', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, twilioHeaders()),
    body: new URLSearchParams({
      To: process.env.ALERT_TO_NUMBER,
      From: process.env.TWILIO_FROM_NUMBER,
      Twiml: twiml
    }).toString()
  });
  if (!res.ok) throw new Error('Twilio call error ' + res.status + ' ' + (await res.text()));
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET is not set' });
  if (req.headers.authorization !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

  const dry = req.query && req.query.dry === '1';
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'ALERT_TO_NUMBER'];
  const missing = required.filter(function (k) { return !process.env[k]; });
  if (!dry && missing.length) return res.status(500).json({ error: 'missing env vars', missing: missing });

  try {
    const rules = config.rules.filter(function (r) { return r.enabled; });
    const coins = Array.from(new Set(rules.map(function (r) { return r.coin; })));
    const prices = coins.length ? await getPrices(coins) : {};
    const results = [];

    const fired = [];
    for (const rule of rules) {
      const message = evaluate(rule, prices[rule.coin]);
      if (message) fired.push({ rule: rule, message: message });
      else results.push({ id: rule.id, fired: false });
    }

    if (fired.length) {
      const text = fired.map(function (f) { return f.message; }).join(' ');
      const cooldown = Math.min.apply(null, fired.map(function (f) { return f.rule.cooldownMinutes; }));
      const ids = fired.map(function (f) { return f.rule.id; });
      if (dry) {
        results.push({ ids: ids, fired: true, called: false, dry: true, message: text });
      } else if (await recentlyCalled(cooldown)) {
        results.push({ ids: ids, fired: true, called: false, reason: 'cooldown' });
      } else {
        await placeCall(text);
        results.push({ ids: ids, fired: true, called: true });
      }
    }
    return res.status(200).json({ ok: true, checked: rules.length, results: results });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
