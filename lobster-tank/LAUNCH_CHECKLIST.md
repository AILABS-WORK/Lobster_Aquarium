# Launch checklist

## 1. Launch token (Pump.fun)

- Create / launch your token on Pump.fun.
- Copy the **mint address** (contract address) once it’s live.

## 2. Set mint in environment

- Open `.env` (local) and set:
  - `TOKEN_MINT=<your_pumpfun_mint>`
  - `NEXT_PUBLIC_TOKEN_MINT=<your_pumpfun_mint>`
- In your **hosting dashboard** (e.g. Vercel), add the same variables so production uses the real mint.  
  **Do not commit `.env`** — it’s in `.gitignore`. Use the host’s “Environment variables” UI.

## 3. Required env for production

| Variable | Purpose |
|----------|--------|
| `DATABASE_URL` | Postgres (e.g. Supabase pooler URL) |
| `HELIUS_API_KEY` | Server-side Solana RPC (feed, claim, balance) |
| `TOKEN_MINT` | Pump.fun mint (owner/claim/feed checks) |
| `NEXT_PUBLIC_TOKEN_MINT` | Same mint, for client gating/display |
| `TANK_BANK_ADDRESS` | Wallet that receives feed transfers |
| `NEXT_PUBLIC_TANK_BANK_ADDRESS` | Same, for UI (“send tokens here”) |
| `AUTH_SECRET` | Session/auth (generate a long random string) |

Optional but recommended: `CRON_SECRET` (if using cron), Moltbook vars, `REQUIRE_PASSWORD_TO_CLAIM`, token min values.

## 4. Leaderboard snapshot (prizes)

- **Endpoint:** `GET /api/leaderboards/snapshot`
- Returns a **unified global leaderboard** across all tanks with **wallet addresses** for prize distribution.
- Query params: `?limit=50` (default 50, max 100).
- Response: `{ entries: [{ rank, lobsterId, displayName, walletAddress, level, xp, wins, points, aquariumId, ... }], snapshotAt, limit }`
- Call this when you’re ready to snapshot; use `walletAddress` (or rank) to determine prize recipients.

## 5. Deploy (git push)

1. Add the correct Pump.fun mint to `.env` **locally** (and in Vercel/host env).
2. **Do not commit `.env`** — it’s ignored.
3. Commit and push only code (and e.g. `LAUNCH_CHECKLIST.md`, `.env.example`):
   ```bash
   git add .
   git status   # ensure .env is not staged
   git commit -m "Launch: snapshot API, launch checklist, env example"
   git push
   ```
4. Your host will deploy on push; ensure all env vars are set in the host’s project settings.

## 6. After deploy

- Test token gating (claim/feed) with the new mint.
- Optionally call `/api/leaderboards/snapshot` and store the result when you lock the prize snapshot.
