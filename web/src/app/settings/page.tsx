"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { useApp } from "@/components/Providers";
import { Spinner, useToast } from "@/components/Toasts";
import { api } from "@/lib/api";
import { profileName, useProfile } from "@/lib/profiles";

// Crops to a centered square and scales to 256px, so any photo uploads small.
async function toAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  return canvas.toDataURL("image/jpeg", 0.9);
}

export default function SettingsPage() {
  const { user, account, signIn, signOut } = useApp();
  const profile = useProfile(user?.uid);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (profile && !name) setName(profile.displayName ?? "");
  }, [profile, name]);

  if (!user)
    return (
      <div className="flex flex-1 items-center justify-center">
        <button onClick={signIn} className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white">
          Sign in with Google
        </button>
      </div>
    );

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return setMsg({ ok: false, text: "Pick an image file." });
    try {
      setPreview(await toAvatarDataUrl(file));
      setMsg(null);
    } catch {
      setMsg({ ok: false, text: "That image couldn't be read. Try a JPEG or PNG." });
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const nameChanged = name.trim() !== (profile?.displayName ?? "");
      await toast.track(api.updateProfile({ ...(nameChanged ? { displayName: name } : {}), ...(preview ? { avatarDataUrl: preview } : {}) }), {
        loading: preview ? "Uploading your photo…" : "Saving your profile…",
        success: "Profile saved",
        error: "Couldn't save your profile",
      });
      setPreview(null);
      setMsg({ ok: true, text: "Saved. Your new name and photo show everywhere, including your chart markers." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const dirty = !!preview || name.trim() !== (profile?.displayName ?? "");

  return (
    <div className="mx-auto w-full max-w-md flex-1 space-y-6 overflow-y-auto px-4 py-10">
      <h1 className="text-xl font-semibold">Profile</h1>
      <form onSubmit={save} className="space-y-5">
        <div className="flex items-center gap-4">
          {preview ? <img src={preview} alt="New photo" className="h-20 w-20 rounded-full object-cover" /> : <Avatar url={profile?.avatarUrl} name={profileName(profile)} size={80} />}
          <div className="space-y-1">
            <button type="button" onClick={() => fileInput.current?.click()} className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-sunken">
              {preview ? "Choose another photo" : "Change photo"}
            </button>
            <p className="text-xs text-muted">Square crop, any image file.</p>
            <input ref={fileInput} id="avatar-file" type="file" accept="image/*" className="hidden" onChange={pick} />
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Display name</span>
          <input id="display-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Your name" />
        </label>
        {profile?.handle && (
          <p className="text-xs text-muted">
            Your profile link:{" "}
            <Link href={`/u/${profile.handle}`} className="text-accent hover:underline">
              /u/{profile.handle}
            </Link>
          </p>
        )}

        <button type="submit" disabled={busy || !dirty || account.status !== "ready" || !name.trim()} className="w-full rounded-md bg-accent py-2 font-semibold text-white disabled:opacity-40">
          {busy ? (
            <span className="inline-flex items-center justify-center gap-2">
              <Spinner /> Saving…
            </span>
          ) : (
            "Save profile"
          )}
        </button>
        {msg && <p className={`text-sm ${msg.ok ? "text-long" : "text-short"}`}>{msg.text}</p>}
      </form>

      <button onClick={signOut} className="text-sm text-muted hover:text-ink">
        Sign out
      </button>
    </div>
  );
}
