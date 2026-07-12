"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, KeyRound } from "lucide-react";

interface Status {
  worker: { stale: boolean; last_poll_seconds: number | null; browser_ok: boolean };
  failing_accounts: { name: string; failures: number }[];
  deactivated_accounts: { name: string }[];
}

export function StatusBanner() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/status")
        .then((r) => (r.ok ? r.json() : null))
        .then(setStatus)
        .catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  if (!status) return null;

  const banners: { key: string; tone: "danger" | "warning"; icon: typeof AlertTriangle; text: string }[] = [];

  if (status.worker.stale) {
    const mins = status.worker.last_poll_seconds
      ? Math.round(status.worker.last_poll_seconds / 60)
      : null;
    banners.push({
      key: "worker",
      tone: "danger",
      icon: AlertTriangle,
      text: `The check-in worker hasn't reported in${mins ? ` for ${mins} min` : ""}. Check-ins may be paused — check the container is running.`,
    });
  }
  for (const a of status.deactivated_accounts) {
    banners.push({
      key: `deact-${a.name}`,
      tone: "danger",
      icon: KeyRound,
      text: `Southwest login for ${a.name} was paused after repeated failures. Update its password on the Accounts page.`,
    });
  }
  for (const a of status.failing_accounts) {
    banners.push({
      key: `fail-${a.name}`,
      tone: "warning",
      icon: KeyRound,
      text: `Southwest login for ${a.name} is failing (${a.failures}/3). It will pause if it keeps failing.`,
    });
  }

  if (banners.length === 0) return null;

  return (
    <div className="space-y-2">
      {banners.map((b) => {
        const fg = b.tone === "danger" ? "var(--danger)" : "var(--warning)";
        const bg = b.tone === "danger" ? "var(--danger-tint)" : "var(--warning-tint)";
        return (
          <div
            key={b.key}
            className="flex items-start gap-2.5 rounded-[var(--radius-sm)] px-4 py-3 text-sm"
            style={{ backgroundColor: bg, color: fg }}
          >
            <b.icon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{b.text}</span>
          </div>
        );
      })}
    </div>
  );
}
