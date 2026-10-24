"use client";

import { useApp } from "./Providers";

// Explains why trading is unavailable instead of letting every action fail.
export function AccountBanner() {
  const { account } = useApp();
  if (account.status === "loading") return <div className="border-b border-line bg-panel px-4 py-1.5 text-xs text-muted">Setting up your trading account…</div>;
  if (account.status === "blocked") return <div className="border-b border-short/40 bg-short/10 px-4 py-2 text-sm text-short">{account.message} You can browse, but trading, deposits and copy-trading are turned off.</div>;
  if (account.status === "error") return <div className="border-b border-line bg-panel px-4 py-2 text-sm text-short">Couldn&apos;t set up your trading account: {account.message}</div>;
  return null;
}
