"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Canvas, useFrame } from "@react-three/fiber";
import type { Group } from "three";
import { LobsterMesh } from "@/components/LobsterMesh";

function MeLobsterViewer({ bodyColor, clawColor, bandanaColor }: { bodyColor: string; clawColor: string; bandanaColor: string | null }) {
  const groupRef = useRef<Group>(null);
  useFrame((_, delta) => {
    if (groupRef.current) groupRef.current.rotation.y += delta * 0.2;
  });
  return (
    <group ref={groupRef} scale={1.2}>
      <LobsterMesh bodyColor={bodyColor} clawColor={clawColor} bandanaColor={bandanaColor} />
    </group>
  );
}

const DEV_OWNER_WALLET = typeof process.env.NEXT_PUBLIC_DEV_OWNER_WALLET === "string" ? process.env.NEXT_PUBLIC_DEV_OWNER_WALLET : undefined;

export function MePanel() {
  const { publicKey, connected } = useWallet();
  const [pastedWallet, setPastedWallet] = useState("");
  const [authStatus, setAuthStatus] = useState<{ hasPassword: boolean; wallet: string | null } | null>(null);
  const [password, setPassword] = useState("");
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [myLobster, setMyLobster] = useState<{
    id: string;
    displayName?: string | null;
    bodyColor?: string | null;
    clawColor?: string | null;
    bandanaColor?: string | null;
    communityColor?: string | null;
  } | null>(null);
  const [editColors, setEditColors] = useState({ bodyColor: "#c85c42", clawColor: "#8b4513", bandanaColor: "#94a3b8", displayName: "" });
  const [saveColorsLoading, setSaveColorsLoading] = useState(false);

  const effectiveWallet = (DEV_OWNER_WALLET && pastedWallet.trim()) ? pastedWallet.trim() : (publicKey?.toBase58() ?? null);

  const fetchAuthStatus = useCallback(async () => {
    if (!effectiveWallet) {
      setAuthStatus({ hasPassword: false, wallet: null });
      return;
    }
    try {
      const res = await fetch("/api/auth/status", {
        headers: { "x-wallet-address": effectiveWallet },
      });
      const data = await res.json();
      setAuthStatus({ hasPassword: data.hasPassword ?? false, wallet: data.wallet ?? effectiveWallet });
    } catch {
      setAuthStatus({ hasPassword: false, wallet: effectiveWallet });
    }
  }, [effectiveWallet]);

  const fetchMe = useCallback(async () => {
    if (!effectiveWallet) {
      setMyLobster(null);
      return;
    }
    try {
      const res = await fetch("/api/me", {
        headers: { "x-wallet-address": effectiveWallet },
      });
      const data = await res.json();
      if (res.ok && data.lobster) {
        setMyLobster({
          id: data.lobster.id,
          displayName: data.lobster.displayName,
          bodyColor: data.lobster.bodyColor,
          clawColor: data.lobster.clawColor,
          bandanaColor: data.lobster.bandanaColor,
          communityColor: data.lobster.communityColor,
        });
        setEditColors({
          bodyColor: data.lobster.bodyColor ?? "#c85c42",
          clawColor: data.lobster.clawColor ?? "#8b4513",
          bandanaColor: data.lobster.bandanaColor ?? data.lobster.communityColor ?? "#94a3b8",
          displayName: data.lobster.displayName ?? "",
        });
      } else {
        setMyLobster(null);
      }
    } catch {
      setMyLobster(null);
    }
  }, [effectiveWallet]);

  useEffect(() => {
    fetchAuthStatus();
  }, [fetchAuthStatus]);

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveWallet || !password.trim() || password.length < 6) {
      setActionStatus("Password must be at least 6 characters.");
      return;
    }
    setLoading(true);
    setActionStatus(null);
    try {
      const res = await fetch("/api/auth/set-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-wallet-address": effectiveWallet,
        },
        body: JSON.stringify({ password: password.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setActionStatus("Password set. You can use it next time to authenticate.");
        setPassword("");
        fetchAuthStatus();
      } else {
        setActionStatus(data.error ?? "Failed to set password.");
      }
    } catch {
      setActionStatus("Request failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveWallet || !password.trim()) {
      setActionStatus("Enter your password.");
      return;
    }
    setLoading(true);
    setActionStatus(null);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-wallet-address": effectiveWallet,
        },
        body: JSON.stringify({ password: password.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setActionStatus("Authenticated.");
        setPassword("");
      } else {
        setActionStatus(data.error ?? "Verification failed.");
      }
    } catch {
      setActionStatus("Request failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-slate-900">Me</h2>
      <p className="text-sm text-slate-600">
        Connect your wallet (or paste address) to own a lobster and receive rewards. Set a password once to sign in later.
      </p>

      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Wallet</h3>
        {DEV_OWNER_WALLET ? (
          <div className="mt-3 space-y-1.5">
            <label className="block text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">
              Dev test wallet
            </label>
            <input
              type="text"
              placeholder="Paste wallet address to test ownership"
              value={pastedWallet}
              onChange={(e) => setPastedWallet(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
            />
            <p className="text-[10px] text-slate-400">
              Used only when NEXT_PUBLIC_DEV_OWNER_WALLET is set.
            </p>
          </div>
        ) : null}
        <div className="mt-3">
          <WalletMultiButton className="!h-10 !rounded-full !bg-teal-500 !text-white hover:!bg-teal-600" />
        </div>
        {connected && publicKey && (
          <p className="mt-2 text-xs text-slate-500">
            {publicKey.toBase58().slice(0, 8)}…{publicKey.toBase58().slice(-8)}
          </p>
        )}
      </div>

      {effectiveWallet && authStatus && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
            One-time password
          </h3>
          <p className="mt-1 text-xs text-slate-600">
            Set a password once when you first connect; use it later to authenticate and unlock actions.
          </p>
          {!authStatus.hasPassword ? (
            <form onSubmit={handleSetPassword} className="mt-4 space-y-3">
              <input
                type="password"
                placeholder="Set password (min 6 characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                minLength={6}
                autoComplete="new-password"
              />
              <button
                type="submit"
                disabled={loading || password.length < 6}
                className="rounded-full bg-teal-500 px-4 py-2 text-sm font-medium text-white hover:bg-teal-600 disabled:opacity-50"
              >
                {loading ? "Setting…" : "Set password (one-time)"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerify} className="mt-4 space-y-3">
              <input
                type="password"
                placeholder="Enter password to authenticate"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                autoComplete="current-password"
              />
              <button
                type="submit"
                disabled={loading || !password.trim()}
                className="rounded-full bg-teal-500 px-4 py-2 text-sm font-medium text-white hover:bg-teal-600 disabled:opacity-50"
              >
                {loading ? "Checking…" : "Authenticate"}
              </button>
            </form>
          )}
          {actionStatus && (
            <p className={`mt-2 text-sm ${actionStatus.startsWith("Auth") || actionStatus.startsWith("Password set") ? "text-teal-600" : "text-amber-600"}`}>
              {actionStatus}
            </p>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Ownership</h3>
        <p className="mt-2 text-sm text-slate-600">
          Any lobster you claim is linked to your wallet address. Only one lobster per wallet. Connect the same wallet later to see your lobster and use pet/feed.
        </p>
      </div>

      {effectiveWallet && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">My Lobster</h3>
          {myLobster ? (
            <>
              <div className="mt-4 h-[200px] w-full overflow-hidden rounded-xl bg-slate-100">
                <Canvas camera={{ position: [0, 0, 2.5], fov: 45 }} style={{ height: "100%", width: "100%" }}>
                  <ambientLight intensity={0.9} />
                  <directionalLight position={[2, 2, 2]} intensity={0.8} />
                  <MeLobsterViewer
                    bodyColor={editColors.bodyColor}
                    clawColor={editColors.clawColor}
                    bandanaColor={editColors.bandanaColor}
                  />
                </Canvas>
              </div>
              <div className="mt-4 space-y-3">
                <div>
                  <label className="block text-[10px] font-medium uppercase tracking-wider text-slate-500">Display name</label>
                  <input
                    type="text"
                    value={editColors.displayName}
                    onChange={(e) => setEditColors((c) => ({ ...c, displayName: e.target.value }))}
                    placeholder={myLobster.id}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div className="flex flex-wrap items-end gap-4">
                  <div>
                    <label className="block text-[10px] text-slate-500">Body</label>
                    <input
                      type="color"
                      value={editColors.bodyColor}
                      onChange={(e) => setEditColors((c) => ({ ...c, bodyColor: e.target.value }))}
                      className="h-9 w-12 cursor-pointer rounded border border-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500">Claws</label>
                    <input
                      type="color"
                      value={editColors.clawColor}
                      onChange={(e) => setEditColors((c) => ({ ...c, clawColor: e.target.value }))}
                      className="h-9 w-12 cursor-pointer rounded border border-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500">Bandana</label>
                    <input
                      type="color"
                      value={editColors.bandanaColor}
                      onChange={(e) => setEditColors((c) => ({ ...c, bandanaColor: e.target.value }))}
                      className="h-9 w-12 cursor-pointer rounded border border-slate-200"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!effectiveWallet) return;
                      setSaveColorsLoading(true);
                      try {
                        const res = await fetch(`/api/lobsters/${myLobster.id}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json", "x-wallet-address": effectiveWallet },
                          body: JSON.stringify({
                            displayName: editColors.displayName.trim() || null,
                            bodyColor: editColors.bodyColor,
                            clawColor: editColors.clawColor,
                            bandanaColor: editColors.bandanaColor,
                          }),
                        });
                        if (res.ok) await fetchMe();
                      } finally {
                        setSaveColorsLoading(false);
                      }
                    }}
                    disabled={saveColorsLoading}
                    className="rounded-full bg-teal-500 px-4 py-2 text-sm font-medium text-white hover:bg-teal-600 disabled:opacity-50"
                  >
                    {saveColorsLoading ? "Saving…" : "Save name & colors"}
                  </button>
                </div>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Bandana uses community colour when you’re in a community; otherwise your chosen bandana colour is used.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-600">
              Claim a lobster in the Tank view (hold 10,000 tokens, then Connect and save name & colors) to see it here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
