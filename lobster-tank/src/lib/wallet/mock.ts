import { TokenBalance, WalletConnection } from "./types";

export const connectMockWallet = async (): Promise<WalletConnection> => {
  return {
    address: "0xMockWallet1234",
    connected: true,
  };
};

export const getMockTokenBalance = async (): Promise<TokenBalance> => {
  return {
    amount: 1200,
    decimals: 0,
  };
};
