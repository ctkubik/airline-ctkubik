"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Wallet, CheckCircle2 } from "lucide-react";

interface Credit {
  id: string;
  account_id: string | null;
  account_display_name: string | null;
  account_username: string | null;
  owner_name: string;
  owner_display_name: string | null;
  owner_username: string | null;
  confirmation_number: string;
  amount: number;
  expiration_date: string | null;
  notes: string;
  is_used: number;
  source: string;
}

interface Account {
  id: string;
  username: string;
  display_name: string;
}

export default function CreditsPage() {
  const [credits, setCredits] = useState<Credit[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [totalActive, setTotalActive] = useState(0);
  const [expiringSoon, setExpiringSoon] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    account_id: "",
    owner_name: "",
    confirmation_number: "",
    amount: "",
    expiration_date: "",
    notes: "",
  });

  const load = useCallback(async () => {
    const [cRes, aRes] = await Promise.all([fetch("/api/credits"), fetch("/api/accounts")]);
    if (cRes.ok) {
      const data = await cRes.json();
      setCredits(data.credits);
      setTotalActive(data.totalActive);
      setExpiringSoon(data.expiringSoon);
      setIsAdmin(!!data.isAdmin);
    }
    if (aRes.ok) setAccounts(await aRes.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const res = await fetch("/api/credits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setForm({ account_id: "", owner_name: "", confirmation_number: "", amount: "", expiration_date: "", notes: "" });
      setShowForm(false);
      await load();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error || "Failed to add credit");
    }
    setSubmitting(false);
  }

  async function patchCredit(id: string, patch: Record<string, unknown>) {
    await fetch(`/api/credits/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await load();
  }

  async function deleteCredit(c: Credit) {
    if (!window.confirm(`Delete the $${c.amount.toFixed(2)} credit (${c.confirmation_number})?`)) return;
    await fetch(`/api/credits/${c.id}`, { method: "DELETE" });
    await load();
  }

  function ownerLabel(c: Credit): string {
    return c.account_display_name || c.account_username || c.owner_name || "—";
  }

  function daysUntil(dateStr: string): number {
    return Math.ceil((new Date(dateStr + "T00:00:00").getTime() - Date.now()) / (24 * 3600 * 1000));
  }

  function expiryBadge(c: Credit) {
    if (c.is_used) return <Badge variant="inactive">used</Badge>;
    if (!c.expiration_date) return <Badge variant="default">no expiration</Badge>;
    const d = daysUntil(c.expiration_date);
    if (d < 0) return <Badge variant="failed">expired</Badge>;
    if (d <= 30) return <Badge variant="failed">expires in {d}d</Badge>;
    if (d <= 90) return <Badge variant="checking_in">expires in {d}d</Badge>;
    return <Badge variant="active">expires {c.expiration_date}</Badge>;
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Travel Credits</h1>
          <p className="text-sm text-gray-500 mt-1">
            Southwest flight credits by person — confirmation number, amount, and expiration.
            Credits on monitored accounts sync automatically (marked <b>synced</b>); you can also add
            any credit manually. Notifications go out 30 and 7 days before a credit expires.
            {isAdmin && " As admin you see everyone's credits; each member sees only their own."}
          </p>
        </div>
        <Button onClick={() => setShowForm((v) => !v)}>
          <Plus className="h-4 w-4 mr-1" /> Add Credit
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 max-w-xl">
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs font-medium text-gray-500">Available credit</div>
            <div className="text-2xl font-bold text-green-700">${totalActive.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs font-medium text-gray-500">Expiring within 60 days</div>
            <div className="text-2xl font-bold text-red-700">${expiringSoon.toFixed(2)}</div>
          </CardContent>
        </Card>
      </div>

      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>Add Travel Credit</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="text-xs font-medium text-gray-600">Belongs to</label>
                <select
                  value={form.account_id}
                  onChange={(e) => setForm({ ...form, account_id: e.target.value })}
                  className="h-10 w-full rounded-md border border-gray-200 bg-white px-3 text-sm"
                >
                  <option value="">— pick an account or type a name →</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.display_name || a.username}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Or a name (no account)</label>
                <Input
                  placeholder="e.g. Uncle Dan"
                  value={form.owner_name}
                  onChange={(e) => setForm({ ...form, owner_name: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Confirmation number</label>
                <Input
                  placeholder="Q4ZR7T"
                  maxLength={8}
                  value={form.confirmation_number}
                  onChange={(e) => setForm({ ...form, confirmation_number: e.target.value.toUpperCase() })}
                  required
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Amount ($)</label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="187.60"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Expiration date (optional)</label>
                <Input
                  type="date"
                  value={form.expiration_date}
                  onChange={(e) => setForm({ ...form, expiration_date: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Notes (optional)</label>
                <Input
                  placeholder="from cancelled DEN trip"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </div>
              <div className="flex gap-2 md:col-span-3">
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Adding…" : "Add Credit"}
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
            <Wallet className="h-5 w-5" /> All Credits ({credits.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-gray-100">
            {credits.map((c) => (
              <div key={c.id} className={`flex flex-wrap items-center gap-3 py-3 ${c.is_used ? "opacity-50" : ""}`}>
                <div className="min-w-[140px]">
                  <div className="font-medium text-gray-900">{ownerLabel(c)}</div>
                  <div className="text-xs text-gray-500 font-mono">{c.confirmation_number}</div>
                </div>
                <div className="font-semibold text-lg tabular-nums">${c.amount.toFixed(2)}</div>
                {expiryBadge(c)}
                {c.source === "southwest" ? (
                  <Badge variant="scheduled">synced</Badge>
                ) : (
                  <Badge variant="default">manual</Badge>
                )}
                {isAdmin && (
                  <span className="text-xs text-gray-400">
                    owner: {c.owner_display_name || c.owner_username || "—"}
                  </span>
                )}
                {c.notes && <span className="text-xs text-gray-500">{c.notes}</span>}
                <div className="ml-auto flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => patchCredit(c.id, { is_used: !c.is_used })}>
                    <CheckCircle2 className="h-4 w-4 mr-1" />
                    {c.is_used ? "Mark unused" : "Mark used"}
                  </Button>
                  {c.source !== "southwest" && (
                    <Button variant="outline" size="sm" onClick={() => deleteCredit(c)}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {credits.length === 0 && (
              <p className="py-3 text-sm text-gray-500">
                No credits tracked yet. When Southwest gives you a flight credit (cancelled or
                rebooked trip), add it here with its confirmation number, amount, and expiration —
                the app will remind you before it expires.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
