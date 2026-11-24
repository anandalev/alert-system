# Crypto alert system

Version: 3.0

Checks crypto prices every 5 minutes (Vercel Cron) and alerts when a coin crosses DOWN through a level.
An alert is 2 voice calls (Twilio) plus 1 email (MailerSend, from info@youtantra.com to the address in alerts.json).

- Repo: anandalev/alert-system, deployed from `main` to the Vercel project `alert-system`
- Code: `api/check.js` (checker), `api/twiml.js` (voice script for the calls)
- Coins and levels: `alerts.json`
- Reset requests: `resets.json`
- State (last price, cooldowns, last crossed times): `alert-state.json` in the private Vercel Blob store connected to the project

## Levels and rules

Each coin has `threshold` and `delta`. Levels are threshold, threshold - delta, threshold - 2*delta, ... (above 0).
A level alerts when the price goes from at or above it to below it between two checks.
Each level alerts at most once per `cooldownHours` (8). Several levels crossed together give one alert.

## Resetting "last crossed" to re-activate alerts

Add an entry to the `resets` array in `resets.json`, commit and push to `main`.
The next timer run (within 5 minutes after the deploy) applies it once.

Each entry needs a NEW unique `id` (for example the date and time). Fields:

| Field | Meaning |
|---|---|
| `id` | Required, unique. An id that was already applied is ignored. |
| `coin` | Coin symbol (`BTC`, `XRP`, `SOL`) or `ALL`. Default `ALL`. |
| `level` | One level to reset (for example `58000` or `0.9`). Omit to reset all levels of the coin. |
| `lastPrice` | Optional. Sets the saved previous price, so levels between it and the current price alert on the next run. |

A reset clears the 8 hour cooldown and the "last crossed" time of the chosen levels.
Without `lastPrice`, a reset level alerts the next time the price crosses down through it.
With `lastPrice` (for example the threshold), levels already below the current price alert on the next run.

Examples:

```json
{
  "resets": [
    { "id": "2026-11-24-2015-all", "coin": "ALL" },
    { "id": "2026-11-25-0900-btc58", "coin": "BTC", "level": 58000 },
    { "id": "2026-11-25-0905-sol", "coin": "SOL", "lastPrice": 70 }
  ]
}
```

Old entries can stay in the file; they are never applied twice.
Check the result in the Vercel runtime logs: the run prints `[alert-check] resets applied: <ids>`.
