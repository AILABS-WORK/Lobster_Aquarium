import { scryptSync, timingSafeEqual } from "crypto";

const SALT_LEN = 16;
const KEY_LEN = 64;

/**
 * Hash a password for storage. Use AUTH_SECRET as pepper.
 */
export function hashPassword(password: string, secret: string): string {
  const salt = Buffer.from(secret.slice(0, SALT_LEN).padEnd(SALT_LEN, "0"), "utf8");
  const key = scryptSync(password, salt, KEY_LEN);
  return key.toString("hex");
}

/**
 * Verify password against stored hash.
 */
export function verifyPassword(password: string, storedHash: string, secret: string): boolean {
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashPassword(password, secret), "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
