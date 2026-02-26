/**
 * Raw PostgreSQL fallback when Prisma is null (e.g. DATABASE_URL was not set at
 * first module load). Used only for TankEvent insert/select so narrator and
 * event persistence work even if Prisma client failed to init.
 */

import { Pool } from "pg";
import { getDatabaseUrl } from "@/lib/db-connection";

let pool: Pool | null = null;

function getPool(): Pool | null {
  if (pool) return pool;
  const url = getDatabaseUrl();
  if (!url) return null;
  try {
    pool = new Pool({ connectionString: url, max: 2 });
    return pool;
  } catch {
    return null;
  }
}

export type TankEventRow = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

/** Insert tank events (skip duplicates by id). Returns count inserted. */
export async function insertTankEvents(
  events: { id: string; type: string; payload: Record<string, unknown>; createdAt: Date }[],
): Promise<number> {
  const p = getPool();
  if (!p || events.length === 0) return 0;
  let inserted = 0;
  for (const e of events) {
    try {
      await p.query(
        `INSERT INTO "TankEvent" (id, type, payload, "createdAt") VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [e.id, e.type, JSON.stringify(e.payload), e.createdAt],
      );
      inserted += 1;
    } catch {
      // skip duplicate or error
    }
  }
  return inserted;
}

/** Fetch tank events since the given date, ordered by createdAt asc. */
export async function getTankEventsSince(since: Date): Promise<TankEventRow[]> {
  const p = getPool();
  if (!p) return [];
  const result = await p.query<TankEventRow>(
    `SELECT id, type, payload, "createdAt" FROM "TankEvent" WHERE "createdAt" >= $1 ORDER BY "createdAt" ASC`,
    [since],
  );
  return result.rows.map((r) => ({
    id: r.id,
    type: r.type,
    payload: (typeof r.payload === "object" && r.payload !== null ? r.payload : {}) as Record<string, unknown>,
    createdAt: r.createdAt,
  }));
}

/** Check if the pg pool can connect (for db-status). */
export async function pgPing(): Promise<boolean> {
  const { ok } = await pgPingWithError();
  return ok;
}

/** Ping and return the actual error message so /api/db-status can show it. */
export async function pgPingWithError(): Promise<{ ok: boolean; errorDetail?: string }> {
  const p = getPool();
  if (!p) return { ok: false, errorDetail: "DATABASE_URL missing or pg pool failed to create" };
  try {
    const res = await p.query("SELECT 1");
    return { ok: res.rowCount !== null && res.rowCount > 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, errorDetail: msg };
  }
}
