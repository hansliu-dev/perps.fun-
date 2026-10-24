import { FieldValue } from "firebase-admin/firestore";
import { getDownloadURL, getStorage } from "firebase-admin/storage";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { db } from "../store.js";
import { tmRuntime } from "../tm/runtime.js";
import { callableOptions, guarded, requireAccount, requireAuth } from "./common.js";

const MAX_PNG_BYTES = 3 * 1024 * 1024;
export const MAX_CAPTION = 70;

// Mid price when the thesis was posted, so the author's marker sits at the right spot on the chart.
async function hyperliquidMid(symbol: string): Promise<number | null> {
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(3000),
    });
    const mid = Number(((await res.json()) as Record<string, string>)[symbol]);
    return Number.isFinite(mid) ? mid : null;
  } catch {
    return null;
  }
}

// Saves the chart snapshot and drawings, and attaches the author's current position in that market.
export const submitThesis = onCall(callableOptions, (req) =>
  guarded(async () => {
    const uid = requireAuth(req);
    const user = await requireAccount(uid);
    const { symbol, period, imageDataUrl, overlays, caption } = req.data as { symbol: string; period: string; imageDataUrl: string; overlays: unknown[]; caption?: string };
    const text = String(caption ?? "").replace(/\s+/g, " ").trim();
    if (text.length > MAX_CAPTION) throw new HttpsError("invalid-argument", `Keep the sentence to ${MAX_CAPTION} characters.`);
    const m = /^data:image\/png;base64,(.+)$/.exec(String(imageDataUrl));
    if (!m) throw new HttpsError("invalid-argument", "The chart snapshot is missing.");
    const png = Buffer.from(m[1], "base64");
    if (png.length > MAX_PNG_BYTES) throw new HttpsError("invalid-argument", "The chart snapshot is too large.");
    if (!Array.isArray(overlays) || overlays.length === 0 || overlays.length > 200) throw new HttpsError("invalid-argument", "Draw at least one line before posting.");

    const ref = db().collection("theses").doc();
    const file = getStorage().bucket().file(`theses/${uid}/${ref.id}.png`);
    await file.save(png, { contentType: "image/png", resumable: false });
    const imageUrl = await getDownloadURL(file);

    const [positions, price] = await Promise.all([tmRuntime().tm.listPositions(user.tmUserId), hyperliquidMid(String(symbol).toUpperCase())]);
    const pos = positions.find((p) => p.symbol.toUpperCase() === String(symbol).toUpperCase());
    await ref.set({
      uid,
      handle: user.handle,
      avatarUrl: user.avatarUrl ?? null,
      symbol: String(symbol).toUpperCase(),
      period: String(period),
      imageUrl,
      caption: text || null,
      price,
      overlays,
      position: pos ? { side: pos.side, leverage: pos.leverage, entry_price: pos.entry_price, size: pos.size } : null,
      ts: FieldValue.serverTimestamp(),
    });
    return { thesisId: ref.id };
  }),
);
