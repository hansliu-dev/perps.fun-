"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/Providers";
import { api } from "./api";

// USDC the user can spend right now, summed across networks (TrueMarkets routes it into Hyperliquid as needed).
export function useAvailableUsdc() {
  const { account } = useApp();
  const [available, setAvailable] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    if (account.status !== "ready") return;
    try {
      const w = await api.getWallet();
      setAvailable(w.balances.reduce((s, b) => s + Number(b.available), 0));
    } catch {
      setAvailable(null);
    }
  }, [account.status]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { available, refresh };
}
