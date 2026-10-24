"use client";

import { doc, getFirestore, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { firebaseApp } from "./firebase";

// Public profile fields from users/{uid}. Read live, so a new name or photo shows up everywhere at once.
export interface Profile {
  uid: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
}

export const profileName = (p?: Profile | null) => p?.displayName || (p?.handle ? `@${p.handle}` : "Trader");

export function useProfiles(uids: string[]): Record<string, Profile> {
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const key = [...new Set(uids)].sort().join(",");
  useEffect(() => {
    const app = firebaseApp();
    if (!app || !key) return;
    const db = getFirestore(app);
    const offs = key.split(",").map((uid) =>
      onSnapshot(doc(db, "users", uid), (d) => {
        if (!d.exists()) return;
        const data = d.data();
        setProfiles((prev) => ({ ...prev, [uid]: { uid, handle: data.handle, displayName: data.displayName, avatarUrl: data.avatarUrl } }));
      }),
    );
    return () => offs.forEach((off) => off());
  }, [key]);
  return profiles;
}

export function useProfile(uid: string | undefined): Profile | null {
  return useProfiles(uid ? [uid] : [])[uid ?? ""] ?? null;
}
