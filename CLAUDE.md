# Instructions for Claude sessions working on this repo

Version: 1.0

Read README.md first. It describes the system, the levels, and the reset procedure.

- When Ananda asks to reset "last crossed", reset alerts, or re-activate alerts: add an entry with a new unique id to `resets.json` as README.md describes, commit and push to `main`. Do not call the /api/check endpoint by hand; the 5 minute timer applies it. Then check the Vercel deployment is READY and, after the next run, look for `[alert-check] resets applied` in the runtime logs of the Vercel project `alert-system`.
- Never use em dashes or en dashes anywhere. Only regular hyphens.
- Every code file has a version comment at the top; increment it on every change.
- Push changes to `main` right away and check that the Vercel deployment succeeded.
- Secrets live only in Vercel environment variables. Never commit them.
