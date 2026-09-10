# Cloudflare Worker version (alternative)

The main project runs on **Vercel** (see the repo root). This folder is the same
tracker as a single Cloudflare Worker with Workers KV instead of Upstash — kept in
case you ever want to move off Vercel. It is **not needed** for the Vercel setup.

- `worker.js` — the whole thing in one file
- `wrangler.toml` — config + hourly cron

Deploy: `npm i -g wrangler`, `wrangler login`, `wrangler kv namespace create TRACK`
(paste the id into `wrangler.toml`), `wrangler secret put SHARED_SECRET`,
`wrangler secret put RESEND_API_KEY`, `wrangler deploy`.

Everything else (the Outlook macro, Resend, the caveats) is identical to the root
README.
