"use client";

// Pick an amount out of what's available by dragging, or with a quick-pick percentage. No typing.
interface Props {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  max: number;
  min?: number;
  step?: number;
  format?: (v: number) => string;
  // Text under the value, e.g. "of $15.00 available".
  caption?: string;
  quickPicks?: boolean;
  disabled?: boolean;
}

export const formatUsd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function AmountSlider({ id, label, value, onChange, max, min = 0, step = 0.01, format = formatUsd, caption, quickPicks = true, disabled }: Props) {
  const usable = !disabled && max >= min && max > 0;
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const pct = usable && max > min ? ((value - min) / (max - min)) * 100 : 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end justify-between">
        <label htmlFor={id} className="text-xs text-muted">
          {label}
        </label>
        <div className="text-right">
          <div className="text-lg font-semibold leading-none tabular-nums">{format(usable ? value : 0)}</div>
          {caption && <div className="mt-0.5 text-[11px] text-muted">{caption}</div>}
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={usable ? max : min + 1}
        step={step}
        value={usable ? value : min}
        disabled={!usable}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="amount-slider w-full"
        style={{ "--fill": `${pct}%` } as React.CSSProperties}
        aria-valuetext={format(value)}
      />
      {quickPicks && (
        <div className="grid grid-cols-4 gap-1">
          {[0.25, 0.5, 0.75, 1].map((f) => {
            const v = clamp(max * f);
            const active = usable && Math.abs(value - v) < step / 2;
            return (
              <button
                key={f}
                type="button"
                disabled={!usable || max * f < min}
                onClick={() => onChange(v)}
                className={`rounded-md py-1 text-[11px] font-medium ${active ? "bg-accent text-white" : "bg-sunken text-muted hover:bg-line hover:text-ink"} disabled:opacity-40`}
              >
                {f === 1 ? "Max" : `${f * 100}%`}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
