"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Send, Trash2 } from "lucide-react";
import type { NotificationConfig } from "@/lib/types";

interface Option {
  value: string | number;
  label: string;
}

interface Step {
  step: string;
  ok: boolean;
  detail: string;
}

function ago(iso: string): string {
  const t = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  const min = Math.round((Date.now() - t) / 60000);
  if (!Number.isFinite(min)) return "";
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} hr ago`;
  return `${Math.round(min / 1440)} days ago`;
}

export function DeliveryStatus({ n }: { n: NotificationConfig }) {
  if (!n.last_status) {
    return <p className="text-xs text-gray-400">Not tested yet. Click Test to check it.</p>;
  }
  const when = n.last_sent_at ? ` (${ago(n.last_sent_at)})` : "";
  if (n.last_status === "ok") {
    return (
      <p className="flex items-center gap-1 text-xs text-green-700">
        <CheckCircle2 className="h-3.5 w-3.5" /> Last message delivered{when}
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1 text-xs text-red-700">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        Last message failed{when}: {n.last_error || "no reason given"}
      </span>
    </p>
  );
}

// One saved notification service: name, who and which alerts, last delivery
// result, Show (full URL, admins only), Test and Delete.
export function NotificationServiceRow({
  n,
  whoOptions,
  levelOptions,
  whoValue,
  onChange,
  onDelete,
  onRefresh,
}: {
  n: NotificationConfig;
  whoOptions: Option[];
  levelOptions: Option[];
  whoValue: string;
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onRefresh: () => void;
}) {
  const [revealed, setRevealed] = useState<{ url: string; token?: string; chats?: string[] } | null>(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string; steps?: Step[] } | null>(null);

  async function toggleReveal() {
    if (revealed) {
      setRevealed(null);
      return;
    }
    setBusy("show");
    const res = await fetch(`/api/notifications/${n.id}`, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setResult({ ok: false, message: body.error || "Couldn't load the details" });
      return;
    }
    setRevealed({ url: body.service_url, token: body.telegram?.token, chats: body.telegram?.chat_ids });
    setDraftUrl(body.service_url);
  }

  async function saveUrl() {
    setBusy("save");
    const res = await fetch(`/api/notifications/${n.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service_url: draftUrl }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setResult({ ok: false, message: body.error || "Couldn't save" });
      return;
    }
    setResult({ ok: true, message: "Saved. Click Test to check it." });
    setRevealed(null);
    onRefresh();
  }

  async function test() {
    setBusy("test");
    setResult(null);
    const started = Date.now();
    const res = await fetch(`/api/notifications/${n.id}/test`, { method: "POST" });
    const body = await res.json().catch(() => ({ ok: false, message: "No answer from the app" }));
    if (!body.queued) {
      setBusy(null);
      setResult(body);
      onRefresh();
      return;
    }
    // The worker sends it; wait for the result it saves on the service
    setResult({ ok: true, message: body.message });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const list = (await fetch("/api/notifications", { cache: "no-store" }).then((r) => r.json())) as NotificationConfig[];
      const me = list.find((x) => x.id === n.id);
      const at = me?.last_sent_at ? new Date(me.last_sent_at).getTime() : 0;
      if (me && at >= started - 5000) {
        setBusy(null);
        setResult(
          me.last_status === "ok"
            ? { ok: true, message: "Delivered. Check your device." }
            : { ok: false, message: me.last_error || "Delivery failed" }
        );
        onRefresh();
        return;
      }
    }
    setBusy(null);
    setResult({
      ok: false,
      message:
        "No answer from the worker after a minute. It may be stopped. Check the Dashboard for a worker warning, or restart it on the Mac with ~/airline-ctkubik/macos/ctl.sh restart",
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 space-y-1">
          <Input
            defaultValue={n.label || ""}
            placeholder="Add a name"
            className="h-8 w-48 text-sm"
            onBlur={(e) => {
              if (e.target.value !== (n.label || "")) onChange({ label: e.target.value });
            }}
          />
          <code className="block break-all text-xs text-gray-500">{revealed ? revealed.url : n.service_url}</code>
          <DeliveryStatus n={n} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={whoValue}
            onChange={(e) => onChange({ account_ids: e.target.value ? [e.target.value] : null })}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs"
            aria-label="Whose alerts"
          >
            {whoOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={Math.min(Math.max(n.notification_level, 1), 3)}
            onChange={(e) => onChange({ notification_level: Number(e.target.value) })}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs"
            aria-label="Which alerts"
          >
            {levelOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={toggleReveal} disabled={busy !== null}>
            {revealed ? <EyeOff className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
            {revealed ? "Hide" : "Show"}
          </Button>
          <Button variant="outline" size="sm" onClick={test} disabled={busy !== null}>
            <Send className="mr-1 h-3.5 w-3.5" />
            {busy === "test" ? "Testing..." : "Test"}
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete} aria-label="Delete">
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        </div>
      </div>

      {revealed && (
        <div className="space-y-2 rounded-md bg-gray-50 p-3 text-xs">
          {revealed.token !== undefined && (
            <div className="grid gap-1 sm:grid-cols-[110px_1fr]">
              <span className="font-medium text-gray-600">Bot token</span>
              <code className="break-all">{revealed.token || "(missing)"}</code>
              <span className="font-medium text-gray-600">Chat ID</span>
              <code>{revealed.chats?.length ? revealed.chats.join(", ") : "(missing)"}</code>
            </div>
          )}
          <label className="block font-medium text-gray-600">Full service URL (edit to fix a typo)</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)} className="h-8 font-mono text-xs" />
            <Button size="sm" onClick={saveUrl} disabled={busy !== null || draftUrl.trim() === revealed.url}>
              {busy === "save" ? "Saving..." : "Save"}
            </Button>
          </div>
          <p className="text-gray-500">Keep this private. Anyone with the bot token can send messages as your bot.</p>
        </div>
      )}

      {result && (
        <div className={`rounded-md p-2 text-xs ${result.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
          <p>{result.message}</p>
          {result.steps && result.steps.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {result.steps.map((s, i) => (
                <li key={i} className="flex gap-1">
                  <span>{s.ok ? "✓" : "✗"}</span>
                  <span className="font-medium">{s.step}:</span>
                  <span>{s.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
