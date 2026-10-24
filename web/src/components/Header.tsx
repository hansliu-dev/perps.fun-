"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { profileName, useProfile } from "@/lib/profiles";
import { Avatar } from "./Avatar";
import { useApp } from "./Providers";

const NAV = [
  { href: "/markets", label: "Trade" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/thesis/new", label: "Post thesis" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Header() {
  const { user, authReady, account, signIn } = useApp();
  const profile = useProfile(user?.uid);
  const name = profile ? profileName(profile) : (user?.displayName ?? "You");
  const path = usePathname();

  return (
    <header className="flex h-12 shrink-0 items-center gap-6 border-b border-line bg-panel px-4">
      <Link href="/markets" className="text-[15px] font-bold tracking-tight">
        perps<span className="text-accent">.fun</span>
      </Link>
      <nav className="flex gap-1 text-sm">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={`rounded-md px-3 py-1.5 transition-colors ${path.startsWith(n.href) ? "bg-sunken text-ink" : "text-muted hover:text-ink"}`}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        {user && account.status === "ready" && (
          <Link href="/portfolio#deposit" className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent/90">
            Deposit
          </Link>
        )}
        {authReady &&
          (user ? (
            <Link href="/settings" className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm text-muted hover:bg-sunken hover:text-ink" title="Edit profile">
              <Avatar url={profile?.avatarUrl ?? user.photoURL ?? undefined} name={name} size={28} />
              <span className="hidden md:inline">{name}</span>
            </Link>
          ) : (
            <button onClick={signIn} className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
              Sign in with Google
            </button>
          ))}
      </div>
    </header>
  );
}
