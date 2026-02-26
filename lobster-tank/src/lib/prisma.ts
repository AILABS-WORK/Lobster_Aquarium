import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getDatabaseUrl } from "@/lib/db-connection";

type PrismaGlobal = { prisma?: PrismaClient | null };
const globalForPrisma = globalThis as unknown as PrismaGlobal;

function createClient(): PrismaClient | null {
  const url = getDatabaseUrl();
  if (!url) {
    return null;
  }
  try {
    const adapter = new PrismaPg({
      connectionString: url,
      max: 10,
    });
    return new PrismaClient({
      adapter,
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    });
  } catch {
    return null;
  }
}

/**
 * Lazy-init: re-checks process.env.DATABASE_URL on each access so that if the
 * app was loaded without DATABASE_URL (e.g. at build time), the client can
 * still be created at runtime when the env is set. Caches the client in all envs.
 */
export function getPrisma(): PrismaClient | null {
  const existing = globalForPrisma.prisma;
  if (existing) return existing;
  const client = createClient();
  if (client) {
    globalForPrisma.prisma = client;
  }
  return client;
}
