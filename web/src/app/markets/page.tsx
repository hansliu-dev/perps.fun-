"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { DEFAULT_SYMBOL } from "@/lib/markets";

export default function MarketsIndex() {
  const router = useRouter();
  useEffect(() => router.replace(`/markets/${DEFAULT_SYMBOL}`), [router]);
  return null;
}
