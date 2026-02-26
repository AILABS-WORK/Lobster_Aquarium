# Lobster Aquarium

A live aquarium simulation where players claim lobsters, feed and pet them, form communities, and compete. Built with Next.js, Solana (Helius), and Postgres.

## Repository

- **App:** [`lobster-tank/`](./lobster-tank) — Next.js app (tank UI, API, sim).
- See [lobster-tank/README.md](./lobster-tank/README.md) for setup, env vars, and deployment.

## Quick start

```bash
cd lobster-tank
npm install
cp .env.example .env   # Edit with your keys; never commit .env
npm run dev
```

Open http://localhost:3000.

## Deploy

Deploy the `lobster-tank` folder to Vercel (or any Node host). Set environment variables as in `lobster-tank/.env.example`. Run Prisma migrations against your Postgres database.

## License

See repository license file.
