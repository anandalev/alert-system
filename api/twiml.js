// alert-system api/twiml.js
// Version: 1.0
// Returns the voice script for an alert call. Twilio fetches this URL when the call is answered
// (trial accounts cannot pass the script inline).
// Query: ?text=<message to read>

function escapeXml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = function handler(req, res) {
  const text = escapeXml(((req.query && req.query.text) || 'Crypto alert.').slice(0, 400));
  const xml = '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    '<Say voice="alice">Crypto alert. ' + text + '</Say><Pause length="1"/>' +
    '<Say voice="alice">' + text + '</Say></Response>';
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(xml);
};
