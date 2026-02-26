"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { publicEnv } from "@/lib/public-env";

type SolanaProvidersProps = {
  children: React.ReactNode;
};

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export const SolanaProviders = ({ children }: SolanaProvidersProps) => {
  const endpoint =
    (typeof publicEnv.NEXT_PUBLIC_SOLANA_RPC_URL === "string" &&
     publicEnv.NEXT_PUBLIC_SOLANA_RPC_URL.trim().startsWith("http"))
      ? publicEnv.NEXT_PUBLIC_SOLANA_RPC_URL.trim()
      : DEFAULT_RPC;
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
