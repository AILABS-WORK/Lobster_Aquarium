# Lobster Tank

Next.js app: live aquarium simulation, Solana (Helius), Postgres. Players claim lobsters, feed and pet them, form communities, and compete.

## Getting started

```bash
npm install
cp .env.example .env   # Edit with your keys; never commit .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

See `.env.example` for all keys. Copy it to `.env` and fill in values.

**Required for production:**

- `HELIUS_API_KEY` — Helius RPC (server-side Solana). Get from [Helius](https://dashboard.helius.dev/).
- `DATABASE_URL` — Postgres connection string (Prisma).
- `AUTH_SECRET` — Secret for password hashing (min 32 chars).
- `TANK_BANK_ADDRESS` — Solana wallet that receives feed tokens.
- `TOKEN_MINT` — SPL token mint address for your lobster token.

**Security (production):**

- Never commit `.env` or real API keys.
- Set `CRON_SECRET` and use it for cron / internal API calls (e.g. tank reset).
- Do **not** set `NEXT_PUBLIC_SHOW_RESET_TANK=true` in production (testing only).
- Do not set `DEV_OWNER_WALLET` / `NEXT_PUBLIC_DEV_OWNER_WALLET` unless you need a dev bypass.

## Database

```bash
npx prisma generate
npx prisma migrate deploy
```

## Deploy

Deploy the `lobster-tank` folder to Vercel (or any Node host). Add all env vars from `.env.example`. Run Prisma migrations against your Postgres database.

## License

See repository license.
