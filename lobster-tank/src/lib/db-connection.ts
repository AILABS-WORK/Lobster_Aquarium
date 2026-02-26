/**
 * Database connection URL for pg/Prisma. In development we force sslmode=no-verify
 * so that pg's connection string parser sets ssl to { rejectUnauthorized: false },
 * fixing "self-signed certificate in certificate chain" with Supabase. Without this,
 * DATABASE_URL's sslmode=require is parsed and overwrites our programmatic ssl config.
 */
export function getDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  if (process.env.NODE_ENV === "production") return url;
  try {
    const u = new URL(url);
    u.searchParams.set("sslmode", "no-verify");
    return u.toString();
  } catch {
    return url;
  }
}
