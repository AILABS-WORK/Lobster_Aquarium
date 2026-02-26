# Lobster Tank — Deployment Guide

## Overview

The Lobster Tank app needs three things to run:
1. **Hosting** — Vercel (recommended) or any Node.js host
2. **Database** — Supabase (Postgres) for users, lobsters, events, stories
3. **Environment variables** — API keys and config

---

## Step 1: Set Up Supabase (Database)

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Choose a region close to your users, set a strong DB password
3. Once the project is created, go to **Settings → Database**
4. Copy the **Connection string (URI)** — it looks like:
   ```
   postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
   ```
   **Important**: Use the **Transaction pooler** (port 6543), not the direct connection (port 5432), for Vercel serverless.
5. Save this — it's your `DATABASE_URL`

### Run Migrations

From your local machine (with the database URL):

```bash
cd lobster-tank
DATABASE_URL="your_supabase_connection_string" npx prisma migrate deploy
```

This creates all the tables (User, Lobster, Aquarium, FeedEvent, etc.).

### Reset for Launch (Clean Slate)

Open the **Supabase SQL Editor** (left sidebar → SQL Editor) and paste the contents of `scripts/reset-for-launch.sql`. Click **Run**. This wipes all test data and ensures the "Global Tank" aquarium exists.

---

## Step 2: Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **Import Project** → select `AILABS-WORK/Lobster_Aquarium`
3. **Root Directory**: Set to `lobster-tank` (click "Edit" next to it)
4. **Framework Preset**: Next.js (should auto-detect)
5. Click **Deploy**

### Set Environment Variables

In Vercel, go to **Settings → Environment Variables** and add:

| Variable | Value | Required |
|---|---|---|
| `DATABASE_URL` | Your Supabase connection string (from Step 1) | Yes |
| `HELIUS_API_KEY` | Your Helius API key ([dashboard.helius.dev](https://dashboard.helius.dev)) | Yes |
| `TANK_BANK_ADDRESS` | Your Solana wallet address (receives feed tokens) | Yes |
| `TOKEN_MINT` | Your SPL token mint address | Yes |
| `AUTH_SECRET` | A long random string (run `openssl rand -hex 32`) | Yes |
| `CRON_SECRET` | Another random string (protects cron endpoints) | Yes |
| `MOLTBOOK_API_KEY` | Your Moltbook agent API key | For narration |
| `MOLTBOOK_SUBMOLT` | `lobster-observatory` | For narration |
| `MOLTBOOK_POSTING_ENABLED` | `true` | For narration |
| `GPT_API_KEY` | OpenAI API key (for AI story generation) | For narration |
| `OPENAI_MODEL` | `gpt-4o-mini` (or `gpt-4o` for better quality) | Optional |
| `TOKEN_OWNER_MIN` | `10000` (min tokens to claim a lobster) | Optional |
| `TOKEN_CARETAKER_MIN` | `100` (min tokens for caretaker tier) | Optional |
| `TOKEN_FEED_MIN` | `100` (min tokens per feed transaction) | Optional |
| `NEXT_PUBLIC_TOKEN_MINT` | Same as TOKEN_MINT (for UI display) | Optional |
| `NEXT_PUBLIC_TANK_BANK_ADDRESS` | Same as TANK_BANK_ADDRESS (for UI display) | Optional |

**Do NOT set** in production:
- `DEV_OWNER_WALLET` — bypasses token checks
- `NEXT_PUBLIC_DEV_OWNER_WALLET` — exposed to client
- `NEXT_PUBLIC_SHOW_RESET_TANK` — allows public tank reset

After adding all env vars, click **Redeploy** (Deployments → three dots → Redeploy).

---

## Step 3: Verify Cron Jobs

The `vercel.json` in the repo configures two cron jobs:

| Schedule | Endpoint | What it does |
|---|---|---|
| Every 10 minutes | `/api/cron/auto-story` | Generates AI story from last 10 min of events, chains with previous story for continuity, saves to DB |
| Every 30 minutes (at :01 and :31) | `/api/cron/auto-molt` | Compiles last 30 min of stories, posts to Moltbook observatory |

**Vercel Cron requires a Pro plan.** On the free plan, crons run once per day max. If you're on Pro, they work automatically.

**Alternative (free plan)**: Use an external cron service like [cron-job.org](https://cron-job.org):
- Create a job hitting `https://your-app.vercel.app/api/cron/auto-story` every 10 min
- Create a job hitting `https://your-app.vercel.app/api/cron/auto-molt` every 30 min
- Add header: `x-cron-secret: <your_CRON_SECRET_value>`

---

## Step 4: Verify Everything Works

1. **Open your site**: `https://your-app.vercel.app`
2. **Check the tank**: You should see an empty tank with shrimp and octopuses swimming
3. **Connect wallet**: Click Login, connect your Phantom/Solflare wallet
4. **Set password**: First-time users set a password
5. **Claim a lobster**: If you hold enough tokens, claim your lobster — it appears in the tank immediately
6. **Feed**: Send tokens to the tank bank address, then verify the transaction
7. **Check another browser/device**: Open the same URL — you should see the same tank state with the same lobster positions

### Health Checks

- `https://your-app.vercel.app/api/db-status` — should return `{"configured": true}`
- `https://your-app.vercel.app/api/tank-state` — should return JSON with lobsters, foods, predators

---

## How It All Works

### Persistent Simulation
The server runs the tank simulation in memory, ticking every 500ms. Lobsters eat, swim, fight, form communities — even when nobody's watching. State is saved to the database every 30 seconds for crash recovery.

### Real-Time Sync
Every user's browser polls the server every 4 seconds for the latest tank state. Everyone sees the same lobster positions, health, communities, etc.

### Multi-Tank
Each aquarium holds up to 120 lobsters. When a user claims a lobster, it's auto-assigned to the first tank with space. If the global tank fills up, create more aquariums in the database:

```sql
INSERT INTO "Aquarium" (id, name, "maxLobsters", "createdAt", "updatedAt")
VALUES ('tank-2', 'Deep Reef', 120, NOW(), NOW());
```

### AI Narration Pipeline
1. Every 10 min: GPT reads the last 10 min of events + the previous story and writes a new chronicle
2. Every 30 min: The accumulated stories are compiled and posted to Moltbook

---

## Custom Domain (Optional)

1. In Vercel → Settings → Domains
2. Add your domain (e.g. `lobstertank.com`)
3. Add the DNS records Vercel gives you at your domain registrar
4. SSL is automatic

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **404 NOT_FOUND on production URL** | Root Directory = `lobster-tank`. Deployments → latest → Promote to Production, or Redeploy with "Clear cache and redeploy". |
| "Database not configured" | Check DATABASE_URL is set in Vercel env vars, redeploy |
| "HELIUS_API_KEY is required" | Add HELIUS_API_KEY to Vercel env vars |
| Lobsters not showing | Run reset-for-launch.sql to ensure "global" aquarium exists |
| Cron not running | Check Vercel Pro plan, or use external cron service |
| "Endpoint URL must start with http" | NEXT_PUBLIC_SOLANA_RPC_URL is empty; leave it unset (client uses public mainnet) |
| 401 on feed verify | Connect wallet first, ensure x-wallet-address header is sent |
| Tank empty after deploy | The sim starts fresh on first request; claim a lobster to populate it |

---

## Quick Reference

- **App code**: `lobster-tank/`
- **Database schema**: `lobster-tank/prisma/schema.prisma`
- **Reset script**: `lobster-tank/scripts/reset-for-launch.sql`
- **Cron config**: `lobster-tank/vercel.json`
- **Env template**: `lobster-tank/.env.example`
