"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

// Bottom-left activity popups. `track` shows a spinner while an action runs, then success or the error.
type ToastState = "loading" | "success" | "error";

interface Toast {
  id: number;
  state: ToastState;
  title: string;
  detail?: string;
  leaving?: boolean;
}

interface TrackLabels<T> {
  loading: string;
  success: string | ((result: T) => string);
  error?: string;
}

interface ToastApi {
  track<T>(work: Promise<T> | (() => Promise<T>), labels: TrackLabels<T>): Promise<T>;
  show(state: Exclude<ToastState, "loading">, title: string, detail?: string): void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number, delay: number) => {
    setTimeout(() => setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, leaving: true } : t))), delay);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), delay + 250);
  }, []);

  const update = useCallback((id: number, patch: Partial<Toast>) => setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t))), []);

  const show = useCallback<ToastApi["show"]>(
    (state, title, detail) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts.slice(-3), { id, state, title, detail }]);
      dismiss(id, state === "error" ? 7000 : 3500);
    },
    [dismiss],
  );

  const track = useCallback<ToastApi["track"]>(
    async (work, labels) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts.slice(-3), { id, state: "loading", title: labels.loading }]);
      try {
        const result = await (typeof work === "function" ? work() : work);
        update(id, { state: "success", title: typeof labels.success === "function" ? labels.success(result) : labels.success });
        dismiss(id, 3500);
        return result;
      } catch (e) {
        update(id, { state: "error", title: labels.error ?? "That didn't go through", detail: message(e) });
        dismiss(id, 7000);
        throw e;
      }
    },
    [dismiss, update],
  );

  return (
    <Ctx.Provider value={{ track, show }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed z-50 flex flex-col gap-2"
        style={{ left: "max(16px, env(safe-area-inset-left, 0px))", bottom: "max(16px, env(safe-area-inset-bottom, 0px))" }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.state === "error" ? "alert" : "status"}
            className={`toast pointer-events-auto flex w-80 items-start gap-3 rounded-lg border bg-panel px-3.5 py-3 text-sm shadow-lg ${t.leaving ? "toast-out" : "toast-in"} ${
              t.state === "error" ? "border-short/40" : t.state === "success" ? "border-long/40" : "border-line"
            }`}
          >
            <span className="mt-0.5">
              {t.state === "loading" ? <Spinner /> : t.state === "success" ? <Check /> : <Cross />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t.title}</span>
              {t.detail && <span className="mt-0.5 block break-words text-xs text-muted">{t.detail}</span>}
            </span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg className="toast-pop h-4 w-4 text-long" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="currentColor" />
      <path className="toast-tick" d="M6 10.5l2.6 2.6L14 7.6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cross() {
  return (
    <svg className="toast-shake h-4 w-4 text-short" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="currentColor" />
      <path d="M7 7l6 6M13 7l-6 6" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
