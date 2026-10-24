"use client";

import { useState } from "react";

// Profile photo with an initial as fallback. no-referrer: Google-hosted photos often refuse requests from other sites.
export function Avatar({ url, name, size = 28 }: { url?: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initial = name.replace(/^@/, "").charAt(0).toUpperCase() || "?";
  if (url && !broken)
    return <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full bg-line font-semibold text-ink" style={{ width: size, height: size, fontSize: size * 0.45 }}>
      {initial}
    </span>
  );
}
