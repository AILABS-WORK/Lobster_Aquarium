"use client";

import { createContext, useContext, type ReactNode } from "react";

type TankContextValue = {
  myLobsterId: string | null;
  publicKey: string | null;
};

const TankContext = createContext<TankContextValue>({
  myLobsterId: null,
  publicKey: null,
});

export function TankProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: TankContextValue;
}) {
  return (
    <TankContext.Provider value={value}>
      {children}
    </TankContext.Provider>
  );
}

export function useTankContext() {
  return useContext(TankContext);
}
