import type * as KC from "klinecharts";

// Custom drawing tools and the thesis avatar marker. KLineChart touches `window` on import,
// so the module is passed in from a client-side dynamic import.
export interface ThesisMarkerData {
  thesisId: string;
  uid: string;
  name: string;
  avatarUrl?: string;
  side?: "long" | "short";
}

const LONG = "#16a34a";
const SHORT = "#dc2626";
const NEUTRAL = "#4d7c0f";
const avatarCache = new Map<string, HTMLImageElement>();

// Loaded without CORS so any host works; the market chart never exports its canvas.
export function preloadAvatar(url: string): Promise<void> {
  if (avatarCache.has(url)) return Promise.resolve();
  return new Promise((resolve) => {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      avatarCache.set(url, img);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = url;
  });
}

interface AvatarAttrs {
  x: number;
  y: number;
  r: number;
  url?: string;
  initial: string;
  color: string;
}

let registered = false;

export function registerCustomOverlays(kc: typeof KC) {
  if (registered) return;
  registered = true;

  kc.registerFigure<AvatarAttrs>({
    name: "avatar",
    draw: (ctx, { x, y, r, url, initial, color }) => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r + 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      const img = url ? avatarCache.get(url) : undefined;
      if (img) {
        ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
      } else {
        ctx.fillStyle = "#1f2937";
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = `600 ${r}px system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(initial, x, y + 1);
      }
      ctx.restore();
    },
    checkEventOn: (c, { x, y, r }) => (c.x - x) ** 2 + (c.y - y) ** 2 <= (r + 2) ** 2,
  });

  kc.registerOverlay<ThesisMarkerData>({
    name: "thesisMarker",
    totalStep: 2,
    lock: true,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      const d = overlay.extendData;
      const color = d.side === "long" ? LONG : d.side === "short" ? SHORT : NEUTRAL;
      const { x, y } = coordinates[0];
      return [{ type: "avatar", attrs: { x, y, r: 12, url: d.avatarUrl, initial: d.name.replace(/^@/, "")[0]?.toUpperCase() ?? "?", color } }];
    },
  });

  kc.registerOverlay({
    name: "arrow",
    totalStep: 3,
    needDefaultPointFigure: true,
    createPointFigures: ({ coordinates }) => {
      if (coordinates.length < 2) return [];
      const [a, b] = coordinates;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = 12;
      const p1 = { x: b.x - head * Math.cos(angle - Math.PI / 7), y: b.y - head * Math.sin(angle - Math.PI / 7) };
      const p2 = { x: b.x - head * Math.cos(angle + Math.PI / 7), y: b.y - head * Math.sin(angle + Math.PI / 7) };
      return [
        { type: "line", attrs: { coordinates: [a, b] } },
        { type: "polygon", attrs: { coordinates: [b, p1, p2] }, styles: { style: "fill" } },
      ];
    },
  });

  kc.registerOverlay({
    name: "rect",
    totalStep: 3,
    needDefaultPointFigure: true,
    createPointFigures: ({ coordinates }) => {
      if (coordinates.length < 2) return [];
      const [a, b] = coordinates;
      return [
        {
          type: "rect",
          attrs: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) },
          styles: { style: "stroke_fill", color: "rgba(59,130,246,0.15)", borderColor: "#3b82f6", borderSize: 1 },
        },
      ];
    },
  });
}

// Drawing tools offered in the thesis toolbar (built-ins + ours).
export const DRAWING_TOOLS = [
  { name: "segment", label: "Trend line", icon: "╱" },
  { name: "rayLine", label: "Ray", icon: "↗" },
  { name: "horizontalStraightLine", label: "Horizontal line", icon: "—" },
  { name: "verticalStraightLine", label: "Vertical line", icon: "│" },
  { name: "priceLine", label: "Price line", icon: "$" },
  { name: "parallelStraightLine", label: "Parallel channel", icon: "⫽" },
  { name: "fibonacciLine", label: "Fibonacci", icon: "φ" },
  { name: "arrow", label: "Arrow", icon: "➚" },
  { name: "rect", label: "Box", icon: "▭" },
  { name: "simpleTag", label: "Price tag", icon: "⌖" },
] as const;

export interface SerializedOverlay {
  name: string;
  points: Array<{ timestamp?: number; value?: number }>;
  styles?: unknown;
  extendData?: unknown;
}

// Drawings saved with a thesis so any chart can redraw them via createOverlay.
export function serializeDrawings(chart: KC.Chart): SerializedOverlay[] {
  return chart
    .getOverlays()
    .filter((o) => o.name !== "thesisMarker")
    .map((o) => ({
      name: o.name,
      points: o.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
      styles: o.styles ?? undefined,
      extendData: o.extendData ?? undefined,
    }));
}

export function restoreDrawings(chart: KC.Chart, drawings: SerializedOverlay[], groupId = "thesis") {
  chart.createOverlay(drawings.map((d) => ({ ...d, groupId, lock: true }) as KC.OverlayCreate));
}
