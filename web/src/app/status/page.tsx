"use client";

import { useEffect, useState } from "react";
import { useApp } from "@/components/Providers";
import { api } from "@/lib/api";

// Deployment check: TrueMarkets judges perp availability by the backend's IP, not the user's.
export default function StatusPage() {
  const { user, signIn } = useApp();
  const [result, setResult] = useState<string>("Checking…");
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) return;
    api
      .serverAvailability()
      .then((r) => {
        const perps = r.allowed_product_types.includes("perp");
        setOk(perps);
        setResult(`Backend location: ${r.country}. Allowed: ${r.allowed_product_types.join(", ") || "nothing"}.`);
      })
      .catch((e) => setResult(e instanceof Error ? e.message : String(e)));
  }, [user]);

  return (
    <div className="mx-auto w-full max-w-xl space-y-3 px-4 py-10 text-sm">
      <h1 className="text-xl font-semibold">Backend status</h1>
      {!user ? (
        <button onClick={signIn} className="rounded-md bg-ink px-3 py-1.5 font-medium text-white">
          Sign in to check
        </button>
      ) : (
        <>
          <p>{result}</p>
          {ok === true && <p className="text-long">Perps are available from the backend&apos;s region.</p>}
          {ok === false && <p className="text-short">Perps are not available from the backend&apos;s region, so every perp order will fail. Deploy the functions to a region where TrueMarkets lists perps.</p>}
        </>
      )}
    </div>
  );
}
