// alert-system api/check.js
// Version: 1.0
// Checks crypto prices against alerts.json and sends SMS through Twilio.
// Called by Vercel Cron every 5 minutes (see vercel.json).
//
// Required env vars:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, ALERT_TO_NUMBER, CRON_SECRET
// Add ?dry=1 to the URL to evaluate rules without sending SMS.

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

// Stateless cooldown: look at recent messages already sent through Twilio.
async function recentlySent(rule) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    To: process.env.ALERT_TO_NUMBER,
    From: process.env.TWILIO_FROM_NUMBER,
    PageSize: '100'
  });
  params.set('DateSent>', since);
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json?' + params.toString();
  const res = await fetch(url, { headers: twilioHeaders() });
  if (!res.ok) throw new Error('Twilio history error ' + res.status);
  const body = await res.json();
  const cutoff = Date.now() - rule.cooldownMinutes * 60 * 1000;
  return (body.messages || []).some(function (m) {
    const t = Date.parse(m.date_sent || m.date_created);
    return t >= cutoff && typeof m.body === 'string' && m.body.indexOf('[' + rule.id + ']') !== -1;
  });
}

async function sendSms(text) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, twilioHeaders()),
    body: new URLSearchParams({
      To: process.env.ALERT_TO_NUMBER,
      From: process.env.TWILIO_FROM_NUMBER,
      Body: text
    }).toString()
  });
  if (!res.ok) throw new Error('Twilio send error ' + res.status + ' ' + (await res.text()));
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

    for (const rule of rules) {
      const message = evaluate(rule, prices[rule.coin]);
      if (!message) { results.push({ id: rule.id, fired: false }); continue; }
      if (dry) { results.push({ id: rule.id, fired: true, sent: false, dry: true, message: message }); continue; }
      if (await recentlySent(rule)) { results.push({ id: rule.id, fired: true, sent: false, reason: 'cooldown' }); continue; }
      await sendSms('[' + rule.id + '] ' + message);
      results.push({ id: rule.id, fired: true, sent: true });
    }
    return res.status(200).json({ ok: true, checked: rules.length, results: results });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
