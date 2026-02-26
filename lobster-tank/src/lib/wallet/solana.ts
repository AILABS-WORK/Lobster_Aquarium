import { Connection, PublicKey } from "@solana/web3.js";
import { TokenBalance } from "./types";

export const getSolanaTokenBalance = async (
  connection: Connection,
  owner: PublicKey,
  mint: string,
): Promise<TokenBalance> => {
  const mintKey = new PublicKey(mint);
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: mintKey,
  });

  let amount = 0;
  let decimals = 0;
  for (const account of accounts.value) {
    const info = account.account.data.parsed?.info;
    if (!info) continue;
    const tokenAmount = info.tokenAmount;
    decimals = tokenAmount.decimals;
    amount += Number(tokenAmount.amount);
  }

  const normalized = decimals ? amount / Math.pow(10, decimals) : amount;
  return {
    amount: normalized,
    decimals,
  };
};
