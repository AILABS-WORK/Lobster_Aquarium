"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

const TOKEN_CLAIM_THRESHOLD = 10_000;

export default function LoginPage() {
  const router = useRouter();
  const { publicKey } = useWallet();
  const [walletOverride, setWalletOverride] = useState("");
  const [redirectCountdown, setRedirectCountdown] = useState(3);
  const redirectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [password, setPassword] = useState("");
  const [authStatus, setAuthStatus] = useState<{ hasPassword: boolean; wallet: string | null } | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [meSummary, setMeSummary] = useState<{ lobster: { id: string; displayName?: string | null } | null } | null>(null);

  const effectiveWallet = (walletOverride.trim() || (publicKey?.toBase58() ?? "")) || null;

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

  const fetchBalance = useCallback(async () => {
    if (!effectiveWallet) {
      setBalance(null);
      return;
    }
    try {
      const res = await fetch(`/api/wallet/balance?address=${encodeURIComponent(effectiveWallet)}`);
      const data = await res.json();
      setBalance(res.ok ? (data.balance ?? 0) : null);
    } catch {
      setBalance(null);
    }
  }, [effectiveWallet]);

  useEffect(() => {
    fetchAuthStatus();
  }, [fetchAuthStatus]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!effectiveWallet) {
      setError("Enter or connect a wallet address.");
      return;
    }
    if (!password.trim()) {
      setError("Enter your password.");
      return;
    }
    if (password.length < 6 && !authStatus?.hasPassword) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setLoading(true);
    try {
      if (authStatus?.hasPassword) {
        const res = await fetch("/api/auth/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-wallet-address": effectiveWallet,
          },
          body: JSON.stringify({ password: password.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Verification failed.");
          return;
        }
      } else {
        const res = await fetch("/api/auth/set-password", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-wallet-address": effectiveWallet,
          },
          body: JSON.stringify({ password: password.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Set password failed.");
          return;
        }
      }
      const meRes = await fetch("/api/me", {
        headers: { "x-wallet-address": effectiveWallet },
      });
      const meData = await meRes.json();
      setMeSummary({ lobster: meRes.ok ? meData.lobster ?? null : null });
      setLoggedIn(true);
    } catch {
      setError("Request failed.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!loggedIn) return;
    setRedirectCountdown(3);
    redirectTimerRef.current = setInterval(() => {
      setRedirectCountdown((prev) => {
        if (prev <= 1) {
          if (redirectTimerRef.current) clearInterval(redirectTimerRef.current);
          router.push("/");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (redirectTimerRef.current) clearInterval(redirectTimerRef.current);
    };
  }, [loggedIn, router]);

  if (loggedIn && meSummary) {
    return (
      <div className="mx-auto max-w-lg space-y-6 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">You&apos;re logged in</h2>
        <p className="text-sm text-slate-600">
          Wallet: <span className="font-mono text-slate-800">{effectiveWallet?.slice(0, 8)}…{effectiveWallet?.slice(-8)}</span>
        </p>
        <p className="text-sm text-slate-700">
          {meSummary.lobster ? (
            <>Your lobster: <strong>{meSummary.lobster.displayName ?? meSummary.lobster.id}</strong></>
          ) : (
            <>No lobster claimed yet. Get 10,000 tokens to claim one in the Tank.</>
          )}
        </p>
        <p className="text-sm text-slate-500">Redirecting to Tank in {redirectCountdown}...</p>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => router.push("/")}
            className="rounded-full bg-teal-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-600"
          >
            Go to Tank now
          </button>
          <button
            type="button"
            onClick={() => router.push("/me")}
            className="rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Me
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Log in</h2>
        <p className="mt-1 text-sm text-slate-600">
          Connect your wallet or paste your address, then set or enter your password to sign in.
        </p>
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">
              Wallet address
            </label>
            <input
              type="text"
              placeholder="Paste wallet address"
              value={walletOverride}
              onChange={(e) => {
                setWalletOverride(e.target.value);
                setError(null);
              }}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
            />
          </div>
          <div className="text-xs text-slate-500">
            Or use connected wallet:{" "}
            <span className="inline-flex">
              <WalletMultiButton className="!inline-flex !h-8 !rounded-full !bg-slate-100 !px-3 !text-xs !text-slate-700 hover:!bg-slate-200" />
            </span>
          </div>
          <div>
            <label className="block text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">
              {authStatus?.hasPassword ? "Password" : "Set password (min 6 characters)"}
            </label>
            <input
              type="password"
              placeholder={authStatus?.hasPassword ? "Enter password" : "Choose a password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              minLength={6}
              autoComplete={authStatus?.hasPassword ? "current-password" : "new-password"}
            />
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <button
            type="submit"
            disabled={loading || !effectiveWallet || !password.trim() || (password.length < 6 && !authStatus?.hasPassword)}
            className="w-full rounded-full bg-teal-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-600 disabled:opacity-50"
          >
            {loading ? "Signing in…" : authStatus?.hasPassword ? "Log in" : "Set password & sign in"}
          </button>
        </form>
      </div>

      {/* Token building */}
      {effectiveWallet && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
            Token building
          </h3>
          <p className="mt-2 text-sm text-slate-600">
            You need {TOKEN_CLAIM_THRESHOLD.toLocaleString()} tokens to claim a lobster. Send tokens to the tank bank to build your balance.
          </p>
          <div className="mt-4 flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-teal-500 transition-all"
                  style={{
                    width: `${Math.min(100, ((balance ?? 0) / TOKEN_CLAIM_THRESHOLD) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {balance !== null ? balance.toLocaleString() : "—"} / {TOKEN_CLAIM_THRESHOLD.toLocaleString()} tokens
              </p>
            </div>
          </div>
        </div>
      )}

      <p className="text-center text-sm text-slate-500">
        <Link href="/" className="text-teal-600 hover:text-teal-700">Back to Tank</Link>
      </p>
    </div>
  );
}
