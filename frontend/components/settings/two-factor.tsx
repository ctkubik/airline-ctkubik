"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck } from "lucide-react";

export function TwoFactor() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/2fa")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setEnabled(!!d.enabled))
      .catch(() => {});
  }, []);

  async function startEnroll() {
    setError("");
    setBusy(true);
    const res = await fetch("/api/2fa", { method: "POST" });
    if (res.ok) {
      const d = await res.json();
      setSecret(d.secret);
      setUri(d.otpauth_uri);
      setEnrolling(true);
    }
    setBusy(false);
  }

  async function confirm() {
    setError("");
    setBusy(true);
    const res = await fetch("/api/2fa", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      setEnabled(true);
      setEnrolling(false);
      setCode("");
      setSecret("");
    } else {
      setError((await res.json().catch(() => null))?.error || "Verification failed");
    }
    setBusy(false);
  }

  async function disable() {
    const c = window.prompt("Enter a current authenticator code to turn off 2FA:");
    if (!c) return;
    setBusy(true);
    const res = await fetch("/api/2fa", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: c }),
    });
    if (res.ok) setEnabled(false);
    else setError((await res.json().catch(() => null))?.error || "Could not disable");
    setBusy(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Two-Factor Authentication
          {enabled && <Badge variant="active">on</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-[color:var(--muted)]">
          Add a one-time code from an authenticator app (Google Authenticator, Authy, 1Password) on top of
          your password. Strongly recommended if you expose this app on a public URL.
        </p>

        {error && (
          <div className="rounded-[var(--radius-sm)] bg-[color:var(--danger-tint)] p-2 text-sm text-[color:var(--danger)]">
            {error}
          </div>
        )}

        {enabled === false && !enrolling && (
          <Button variant="outline" size="sm" onClick={startEnroll} disabled={busy}>
            Enable 2FA
          </Button>
        )}

        {enabled && !enrolling && (
          <Button variant="outline" size="sm" onClick={disable} disabled={busy}>
            Disable 2FA
          </Button>
        )}

        {enrolling && (
          <div className="space-y-3 rounded-[var(--radius-sm)] border border-[color:var(--line)] bg-[color:var(--surface-2)] p-4">
            <p className="text-sm text-[color:var(--ink-soft)]">
              1. In your authenticator app, add an account and enter this setup key:
            </p>
            <code className="block break-all rounded bg-[color:var(--surface)] px-3 py-2 font-mono text-sm tracking-wider">
              {secret}
            </code>
            <p className="text-xs text-[color:var(--faint)]">
              (Or open this link on the same device:{" "}
              <a href={uri} className="text-[color:var(--accent)] underline">
                add to authenticator
              </a>
              )
            </p>
            <p className="text-sm text-[color:var(--ink-soft)]">2. Enter the current 6-digit code to confirm:</p>
            <div className="flex gap-2">
              <Input
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="w-40"
              />
              <Button size="sm" onClick={confirm} disabled={busy || code.length < 6}>
                Confirm
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEnrolling(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
