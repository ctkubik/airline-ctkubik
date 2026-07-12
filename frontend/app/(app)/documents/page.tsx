"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, ShieldCheck, Eye, EyeOff } from "lucide-react";

interface Doc {
  id: string;
  owner_user_id: string | null;
  owner_display_name: string | null;
  owner_username: string | null;
  doc_type: string;
  label: string;
  holder_name: string;
  number: string;
  expiration_date: string | null;
  notes: string;
}

const DOC_TYPES: { value: string; label: string }[] = [
  { value: "passport", label: "Passport" },
  { value: "global_entry", label: "Global Entry" },
  { value: "tsa_precheck", label: "TSA PreCheck" },
  { value: "known_traveler", label: "Known Traveler #" },
  { value: "visa", label: "Visa" },
  { value: "drivers_license", label: "Driver's license" },
  { value: "loyalty", label: "Loyalty / frequent flyer" },
  { value: "other", label: "Other" },
];

const typeLabel = (v: string) => DOC_TYPES.find((t) => t.value === v)?.label || "Document";

export default function DocumentsPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    doc_type: "passport",
    holder_name: "",
    label: "",
    number: "",
    expiration_date: "",
    notes: "",
  });

  const load = useCallback(async () => {
    const res = await fetch("/api/documents");
    if (res.ok) {
      const data = await res.json();
      setDocs(data.documents);
      setIsAdmin(!!data.isAdmin);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const res = await fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setForm({ doc_type: "passport", holder_name: "", label: "", number: "", expiration_date: "", notes: "" });
      setShowForm(false);
      await load();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error || "Failed to add document");
    }
    setSubmitting(false);
  }

  async function deleteDoc(d: Doc) {
    if (!window.confirm(`Delete ${typeLabel(d.doc_type)} for ${d.holder_name || "this holder"}?`)) return;
    await fetch(`/api/documents/${d.id}`, { method: "DELETE" });
    await load();
  }

  function daysUntil(dateStr: string): number {
    return Math.ceil((new Date(dateStr + "T00:00:00").getTime() - Date.now()) / (24 * 3600 * 1000));
  }

  function expiryBadge(d: Doc) {
    if (!d.expiration_date) return <Badge variant="default">no expiration</Badge>;
    const days = daysUntil(d.expiration_date);
    if (days < 0) return <Badge variant="failed">expired</Badge>;
    if (days <= 30) return <Badge variant="failed">expires in {days}d</Badge>;
    if (days <= 180) return <Badge variant="checking_in">expires {d.expiration_date}</Badge>;
    return <Badge variant="active">valid to {d.expiration_date}</Badge>;
  }

  function maskNumber(n: string): string {
    if (!n) return "—";
    if (n.length <= 4) return "••" + n;
    return "•••• " + n.slice(-4);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="eyebrow mb-1">Travel</div>
          <h1 className="text-[28px] font-semibold tracking-tight">Documents</h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">
            Passports, Global Entry, TSA PreCheck, and loyalty numbers — with reminders 30 and 7 days
            before anything expires. Numbers are encrypted at rest.
            {isAdmin && " As admin you see the whole family's; each member sees only their own."}
          </p>
        </div>
        <Button onClick={() => setShowForm((v) => !v)}>
          <Plus className="h-4 w-4" /> Add Document
        </Button>
      </header>

      {error && (
        <div className="rounded-[var(--radius-sm)] bg-[color:var(--danger-tint)] p-3 text-sm text-[color:var(--danger)]">
          {error}
        </div>
      )}

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>Add Document</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="eyebrow mb-1 block">Type</label>
                <select
                  value={form.doc_type}
                  onChange={(e) => setForm({ ...form, doc_type: e.target.value })}
                  className="h-10 w-full rounded-[var(--radius-sm)] border border-[color:var(--line-strong)] bg-[color:var(--surface)] px-3 text-sm"
                >
                  {DOC_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="eyebrow mb-1 block">Holder</label>
                <Input
                  placeholder="e.g. Chad Kubik"
                  value={form.holder_name}
                  onChange={(e) => setForm({ ...form, holder_name: e.target.value })}
                />
              </div>
              <div>
                <label className="eyebrow mb-1 block">Label (optional)</label>
                <Input
                  placeholder="e.g. US passport"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                />
              </div>
              <div>
                <label className="eyebrow mb-1 block">Number (encrypted)</label>
                <Input
                  placeholder="document number"
                  value={form.number}
                  onChange={(e) => setForm({ ...form, number: e.target.value })}
                />
              </div>
              <div>
                <label className="eyebrow mb-1 block">Expiration date</label>
                <Input
                  type="date"
                  value={form.expiration_date}
                  onChange={(e) => setForm({ ...form, expiration_date: e.target.value })}
                />
              </div>
              <div>
                <label className="eyebrow mb-1 block">Notes (optional)</label>
                <Input
                  placeholder="e.g. renewal appointment booked"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </div>
              <div className="flex gap-2 md:col-span-3">
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Saving…" : "Save Document"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" /> All Documents ({docs.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-[color:var(--line)]">
            {docs.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div className="min-w-[150px]">
                  <div className="font-medium text-[color:var(--ink)]">
                    {d.label || typeLabel(d.doc_type)}
                  </div>
                  <div className="text-xs text-[color:var(--muted)]">
                    {typeLabel(d.doc_type)}
                    {d.holder_name ? ` · ${d.holder_name}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2 font-mono text-[13px] text-[color:var(--ink-soft)]">
                  {d.number ? (reveal[d.id] ? d.number : maskNumber(d.number)) : "—"}
                  {d.number && (
                    <button
                      onClick={() => setReveal((r) => ({ ...r, [d.id]: !r[d.id] }))}
                      className="text-[color:var(--faint)] hover:text-[color:var(--accent)]"
                      aria-label={reveal[d.id] ? "Hide number" : "Reveal number"}
                    >
                      {reveal[d.id] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </div>
                {expiryBadge(d)}
                {isAdmin && (
                  <span className="text-xs text-[color:var(--faint)]">
                    owner: {d.owner_display_name || d.owner_username || "—"}
                  </span>
                )}
                {d.notes && <span className="text-xs text-[color:var(--muted)]">{d.notes}</span>}
                <div className="ml-auto">
                  <Button variant="outline" size="sm" onClick={() => deleteDoc(d)}>
                    <Trash2 className="h-4 w-4 text-[color:var(--danger)]" />
                  </Button>
                </div>
              </div>
            ))}
            {docs.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-[color:var(--muted)]">
                No documents yet. Add passports and trusted-traveler memberships so the app can remind
                you before they expire — right when it would derail a trip.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
