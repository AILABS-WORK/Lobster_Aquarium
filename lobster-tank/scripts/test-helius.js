/**
 * Test that Helius RPC works (HELIUS_API_KEY in .env).
 * Run from lobster-tank: node scripts/test-helius.js
 * Or: npm run test-helius
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Connection } = require("@solana/web3.js");

function getRpcUrl() {
  const helius = (process.env.HELIUS_API_KEY || "").trim();
  if (!helius) throw new Error("HELIUS_API_KEY is required in .env");
  return `https://mainnet.helius-rpc.com/?api-key=${helius}`;
}

async function main() {
  const url = getRpcUrl();
  console.log("RPC: Helius mainnet");
  const conn = new Connection(url);
  try {
    const slot = await conn.getSlot();
    const block = await conn.getBlockHeight();
    console.log("OK – Helius (or configured RPC) is working.");
    console.log("  Slot:", slot, "| Block height:", block);
  } catch (err) {
    console.error("RPC error:", err.message || err);
    process.exit(1);
  }
}

main();
