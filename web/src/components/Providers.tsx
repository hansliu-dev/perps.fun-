"use client";

import { GoogleAuthProvider, getAuth, onAuthStateChanged, reauthenticateWithPopup, signInWithPopup, signOut, type User } from "firebase/auth";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { firebaseApp, firebaseConfigured } from "@/lib/firebase";

// "blocked": the backend refused this user's country; trading UI stays read-only.
export type AccountState = { status: "none" | "loading" | "ready" } | { status: "blocked" | "error"; message: string };

interface AppState {
  user: User | null;
  authReady: boolean;
  account: AccountState;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  reauth: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside Providers");
  return v;
}

export function Providers({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!firebaseConfigured);
  const [account, setAccount] = useState<AccountState>({ status: "none" });

  useEffect(() => {
    const app = firebaseApp();
    if (!app) return;
    return onAuthStateChanged(getAuth(app), (u) => {
      setUser(u);
      setAuthReady(true);
      if (!u) return setAccount({ status: "none" });
      // Creates the TrueMarkets account on first sign-in; safe to repeat.
      setAccount({ status: "loading" });
      api
        .onboard()
        .then(() => setAccount({ status: "ready" }))
        .catch((e: { code?: string; message?: string }) =>
          setAccount({ status: e.code === "functions/permission-denied" ? "blocked" : "error", message: e.message ?? String(e) }),
        );
    });
  }, []);

  const doSignIn = useCallback(async () => {
    const app = firebaseApp();
    if (!app) {
      alert("Firebase isn't configured yet: add NEXT_PUBLIC_FIREBASE_* to web/.env.local");
      return;
    }
    await signInWithPopup(getAuth(app), new GoogleAuthProvider());
  }, []);

  const doSignOut = useCallback(async () => {
    const app = firebaseApp();
    if (app) await signOut(getAuth(app));
  }, []);

  const reauth = useCallback(async () => {
    const app = firebaseApp();
    const current = app ? getAuth(app).currentUser : null;
    if (current) await reauthenticateWithPopup(current, new GoogleAuthProvider());
  }, []);

  return <Ctx.Provider value={{ user, authReady, account, signIn: doSignIn, signOut: doSignOut, reauth }}>{children}</Ctx.Provider>;
}
