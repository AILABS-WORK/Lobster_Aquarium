"use client";

import { Suspense } from "react";
import { TankShell } from "@/components/TankShell";

/**
 * Persistent layout for tank routes. TankShell (and thus TankScene/sim) stays mounted
 * when navigating between /, /leaderboards, /community, /me — sim state persists.
 */
export default function TankLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50 p-4">Loading…</div>}>
      <TankShell>{children}</TankShell>
    </Suspense>
  );
}
