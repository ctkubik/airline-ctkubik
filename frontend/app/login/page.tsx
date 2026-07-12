"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plane, AlertCircle } from "lucide-react";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
      router.push("/");
      router.refresh();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error || "Invalid username or password");
    }
    setLoading(false);
  }

  return (
    <div className="grid min-h-screen bg-[color:var(--ground)] lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden bg-[color:var(--brand)] lg:block">
        <BoardingBackdrop />
        <div className="relative z-10 flex h-full flex-col justify-between p-12 text-[color:var(--on-brand)]">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-[color:var(--accent)] shadow-sm">
              <Plane className="h-5 w-5 -rotate-45 text-white" />
            </span>
            <span className="font-display text-lg font-semibold tracking-tight">SW Check-In</span>
          </div>

          <div className="max-w-md">
            <div className="eyebrow mb-3 !text-[color:var(--on-brand-muted)]">Never miss a boarding window</div>
            <h1 className="font-display text-[40px] font-semibold leading-[1.08] tracking-tight text-white">
              Your family&apos;s flights, checked in the moment they open.
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-[color:var(--on-brand-muted)]">
              Automatic check-ins 24 hours out, fare drops across every airline, travel-credit
              reminders, and a login for everyone — all from one calm dashboard.
            </p>
          </div>

          <div className="flex items-center gap-6 font-mono text-[13px] text-[color:var(--on-brand-muted)]">
            <span>MKE</span>
            <span className="flex-1 border-t border-dashed border-white/20" />
            <Plane className="h-4 w-4 -rotate-45 text-[color:var(--accent)]" />
            <span className="flex-1 border-t border-dashed border-white/20" />
            <span>PHX</span>
          </div>
        </div>
      </div>

      {/* Sign-in panel */}
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-[color:var(--accent)] shadow-sm">
              <Plane className="h-6 w-6 -rotate-45 text-white" />
            </span>
          </div>

          <div className="eyebrow mb-2">Welcome back</div>
          <h2 className="font-display text-[26px] font-semibold tracking-tight text-[color:var(--ink)]">
            Sign in to your dashboard
          </h2>
          <p className="mt-1.5 text-sm text-[color:var(--muted)]">
            Enter the credentials your admin set up for you.
          </p>

          <form onSubmit={handleSubmit} className="mt-7 space-y-4">
            {error && (
              <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[color:var(--danger)]/25 bg-[color:var(--danger-tint)] p-3 text-sm text-[color:var(--danger)]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-[color:var(--ink-soft)]">
                Username
              </label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="your username"
                required
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-[color:var(--ink-soft)]">
                Password
              </label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={loading}>
              {loading ? "Signing in…" : "Sign In"}
            </Button>
          </form>

          <p className="mt-6 text-center text-xs text-[color:var(--faint)]">
            Protected by rate-limiting and encrypted credential storage.
          </p>
        </div>
      </div>
    </div>
  );
}

// A faint departure-board / flight-path motif behind the brand panel.
function BoardingBackdrop() {
  return (
    <svg
      className="absolute inset-0 h-full w-full opacity-[0.5]"
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 600 800"
      fill="none"
      aria-hidden
    >
      <defs>
        <radialGradient id="glow" cx="30%" cy="20%" r="80%">
          <stop offset="0%" stopColor="#2a3f66" />
          <stop offset="100%" stopColor="transparent" />
        </radialGradient>
      </defs>
      <rect width="600" height="800" fill="url(#glow)" />
      <path
        d="M-40 640 C 160 520, 300 560, 420 380 S 620 120, 700 40"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeDasharray="6 8"
        opacity="0.55"
      />
      <circle cx="420" cy="380" r="4" fill="var(--accent)" />
      <circle cx="-40" cy="640" r="4" fill="#ffffff" opacity="0.5" />
    </svg>
  );
}
