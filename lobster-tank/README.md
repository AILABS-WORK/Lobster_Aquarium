Lobster Tank is a Next.js app with a Canvas-based aquarium simulation and AI narration. This README covers local setup, env vars, and deployment.

## Getting Started

```bash
npm install
cp .env.example .env   # Edit with your keys; never commit .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

Copy `.env.example` to `.env` and fill in values. See `.env.example` for comments.

**Required for production:** `DATABASE_URL`, `HELIUS_API_KEY`, `TANK_BANK_ADDRESS`, `TOKEN_MINT`, `AUTH_SECRET`.

**Production security (leave unset):**
- Do **not** set `DEV_OWNER_WALLET` or `NEXT_PUBLIC_DEV_OWNER_WALLET` in production (dev bypass).
- Do **not** set `NEXT_PUBLIC_SHOW_RESET_TANK=true` in production (allows public tank reset).

### Feeding

- Token-to-food: 100 tokens = 1 feed (configurable via `TOKEN_FEED_MIN`). Stored and applied in `/api/feed/verify`.
- Optional `PUM_TOKEN_MINT`: accept a test token for feed verify alongside `TOKEN_MINT`.

## Notes

- `src/lib/env.ts` validates server env; `src/lib/public-env.ts` validates `NEXT_PUBLIC_*` (exposed to the browser).

## Deployment

- Deploy the `lobster-tank` folder to Vercel (or any Node host).
- Set all required env vars in the host dashboard. Run Prisma migrations against your Postgres database: `npx prisma migrate deploy`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
