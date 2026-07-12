"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CalendarDays, Copy, Check, RefreshCw } from "lucide-react";

export function CalendarFeed() {
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/calendar/token")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.token && setToken(d.token))
      .catch(() => {});
  }, []);

  const url = token
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/calendar/${token}`
    : "";

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function regenerate() {
    if (!window.confirm("Regenerate your calendar link? The old link will stop working.")) return;
    setBusy(true);
    const res = await fetch("/api/calendar/token", { method: "POST" });
    if (res.ok) setToken((await res.json()).token);
    setBusy(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5" /> Calendar Feed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-[color:var(--muted)]">
          Subscribe to your flights and check-in times in Apple Calendar, Google Calendar, or Outlook.
          Add this as a <strong>subscription URL</strong> (not an import) so it stays up to date. It shows
          only your own flights.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-[var(--radius-sm)] border border-[color:var(--line)] bg-[color:var(--surface-2)] px-3 py-2 font-mono text-xs text-[color:var(--ink-soft)]">
            {url || "Generating…"}
          </code>
          <Button variant="outline" size="sm" onClick={copy} disabled={!url}>
            {copied ? <Check className="h-4 w-4 text-[color:var(--success)]" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="ghost" size="sm" onClick={regenerate} disabled={busy}>
            <RefreshCw className="h-4 w-4" /> Reset link
          </Button>
        </div>
        <p className="text-xs text-[color:var(--faint)]">
          Tip (Google Calendar): Other calendars → From URL → paste. Tip (Apple): File → New Calendar
          Subscription → paste.
        </p>
      </CardContent>
    </Card>
  );
}
