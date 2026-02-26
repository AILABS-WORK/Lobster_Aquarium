# Security

- **Never commit `.env`** or any file containing API keys, `CRON_SECRET`, `AUTH_SECRET`, or `HELIUS_API_KEY`. Use `.env.example` as a template only.
- **Production:** Set `CRON_SECRET` and use it for cron / internal API calls (e.g. tank reset). Do not set `NEXT_PUBLIC_SHOW_RESET_TANK=true`.
- **Secrets:** All server-only keys (`HELIUS_API_KEY`, `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, `MOLTBOOK_API_KEY`, `GPT_API_KEY`) are read from the environment on the server and are not exposed to the client. Only `NEXT_PUBLIC_*` variables are exposed to the browser.
- **Reset tank:** `POST /api/tank-reset` requires `CRON_SECRET` (or `NEXT_PUBLIC_SHOW_RESET_TANK=true` for testing only). Do not enable the reset button in production.
