# Lobster Tank

Next.js aquarium simulation: claim a lobster, feed and pet it, form communities, and watch the tank live. Uses Solana (Helius RPC), Postgres, and optional AI narration.

## Getting Started

```bash
cd lobster-tank
npm install
cp .env.example .env
# Edit .env with your values (see below). Never commit .env.
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

Copy `.env.example` to `.env` and set:

| Variable | Required | Description |
|----------|----------|-------------|
| `HELIUS_API_KEY` | Yes | [Helius](https://dashboard.helius.dev) API key for Solana RPC |
| `DATABASE_URL` | Yes | Postgres connection string (e.g. Supabase) |
| `TANK_BANK_ADDRESS` | Yes | Solana wallet that receives token transfers |
| `NEXT_PUBLIC_TANK_BANK_ADDRESS` | Yes | Same; exposed to frontend |
| `TOKEN_MINT` | Yes | Game token mint address |
| `NEXT_PUBLIC_TOKEN_MINT` | Yes | Same; exposed to frontend |
| `AUTH_SECRET` | Yes | Random secret for password hashing (e.g. `openssl rand -hex 32`) |

Optional: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `MOLTBOOK_*`, `GPT_API_KEY`, `CRON_SECRET`, `TOKEN_OWNER_MIN`, `TOKEN_CARETAKER_MIN`, `TOKEN_FEED_MIN`, `REQUIRE_PASSWORD_TO_CLAIM`. See `.env.example`.

**Security:** Do not commit `.env` or any file containing real keys. Only `NEXT_PUBLIC_*` vars are exposed to the browser; never put secrets there.

## Deployment

- **Vercel:** Connect the repo, set env vars in the dashboard, deploy. Use the same vars as `.env.example` (no real values in the UI).
- **Database:** Run Prisma migrations: `npx prisma migrate deploy`.
- **Production:** Set `CRON_SECRET` for cron/reset endpoints. Leave `NEXT_PUBLIC_SHOW_RESET_TANK` unset. Do not set `DEV_OWNER_WALLET` / `NEXT_PUBLIC_DEV_OWNER_WALLET`.

## Scripts

- `npm run dev` — development server
- `npm run build` — production build
- `npm run test-helius` — verify Helius RPC (requires `HELIUS_API_KEY` in `.env`)

## Learn More

- [Next.js](https://nextjs.org/docs)
- [Helius](https://docs.helius.dev)
- [Prisma](https://www.prisma.io/docs)
