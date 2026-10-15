"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { KeyRound, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";

interface Program {
  name: string;
  airline: string;
  unit: string;
  home_url: string;
  tiers: string[];
}

interface HistoryPoint {
  balance: number | null;
  status_tier: string;
  source: string;
  recorded_at: string;
}

interface LoyaltyAccount {
  id: string;
  program: string;
  program_name: string;
  owner_name: string;
  member_number: string;
  username: string;
  login_url: string;
  account_url: string;
  sync_enabled: number;
  balance: number | null;
  balance_unit: string;
  status_tier: string;
  status_detail: string;
  status_expires: string | null;
  points_expire: string | null;
  last_synced_at: string | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  sync_requested: string | null;
  has_password: number;
  history: HistoryPoint[];
}

interface Payload {
  accounts: LoyaltyAccount[];
  programs: Record<string, Program>;
  sync_interval_hours: number;
  can_sign_in_by_hand: boolean;
}

const ACTIVE = ["queued", "running", "needs_code", "waiting_signin"];

const emptyForm = {
  program: "delta",
  program_name: "",
  owner_name: "",
  member_number: "",
  username: "",
  password: "",
  sync_enabled: true,
  login_url: "",
  account_url: "",
  balance: "",
  status_tier: "",
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`).getTime();
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function Sparkline({ points }: { points: HistoryPoint[] }) {
  const values = points.map((p) => p.balance).filter((v): v is number => v !== null);
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${((i / (values.length - 1)) * 100).toFixed(1)},${(28 - ((v - min) / span) * 24).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" className="h-8 w-28" preserveAspectRatio="none" aria-label="Balance history">
      <path d={d} fill="none" stroke="#2563eb" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function statusBadge(a: LoyaltyAccount) {
  switch (a.last_sync_status) {
    case "ok":
      return <Badge variant="success">Synced {ago(a.last_synced_at)}</Badge>;
    case "queued":
    case "running":
      return <Badge variant="checking_in">Syncing...</Badge>;
    case "needs_code":
      return <Badge variant="checking_in">Needs a code</Badge>;
    case "waiting_signin":
      return <Badge variant="checking_in">Waiting for you to sign in</Badge>;
    case "bad_login":
      return <Badge variant="failed">Password rejected</Badge>;
    case "blocked":
      return <Badge variant="failed">Robot check</Badge>;
    case "needs_signin":
      return <Badge variant="failed">Signed out</Badge>;
    case "error":
      return <Badge variant="failed">Sync failed</Badge>;
    default:
      return a.has_password ? <Badge variant="pending">Not synced yet</Badge> : <Badge variant="pending">Updated by hand</Badge>;
  }
}

export default function MilesPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/loyalty");
    if (res.ok) setData(await res.json());
  }, []);

  const syncing = Boolean(data?.accounts.some((a) => ACTIVE.includes(a.last_sync_status ?? "") || a.sync_requested));
  useEffect(() => {
    load();
    const t = setInterval(load, syncing ? 4000 : 60000);
    return () => clearInterval(t);
  }, [load, syncing]);

  async function act(id: string, body: Record<string, unknown>) {
    setError("");
    const res = await fetch(`/api/loyalty/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) setError((await res.json().catch(() => null))?.error || "That didn't work");
    load();
  }

  function startEdit(a: LoyaltyAccount) {
    setEditId(a.id);
    setForm({
      program: a.program,
      program_name: a.program_name,
      owner_name: a.owner_name,
      member_number: a.member_number,
      username: a.username,
      password: "",
      sync_enabled: Boolean(a.sync_enabled),
      login_url: a.login_url,
      account_url: a.account_url,
      balance: a.balance === null ? "" : String(a.balance),
      status_tier: a.status_tier,
    });
    setAdvanced(Boolean(a.login_url || a.account_url));
    setShowForm(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body: Record<string, unknown> = { ...form };
    if (editId && !form.password) delete body.password; // keep the saved one
    const res = await fetch(editId ? `/api/loyalty/${editId}` : "/api/loyalty", {
      method: editId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error || "Couldn't save");
      return;
    }
    setShowForm(false);
    setEditId(null);
    setForm(emptyForm);
    load();
  }

  async function remove(a: LoyaltyAccount, name: string) {
    if (!window.confirm(`Remove ${name}? This also deletes its saved sign-in and history.`)) return;
    await fetch(`/api/loyalty/${a.id}`, { method: "DELETE" });
    load();
  }

  if (!data) return <div className="text-sm text-gray-500">Loading...</div>;
  const programs = data.programs;
  const days = Math.round(data.sync_interval_hours / 24);
  const chosen = programs[form.program];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Miles &amp; Status</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Balances and elite status for every airline program. With a saved login, the Mac signs in about every{" "}
            {days} days and reads your account page. Without one, update the numbers by hand.
          </p>
        </div>
        <Button onClick={() => { setEditId(null); setForm(emptyForm); setAdvanced(false); setShowForm(!showForm); }}>
          <Plus className="mr-2 h-4 w-4" /> Add program
        </Button>
      </div>

      {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>{editId ? "Edit program" : "Add a program"}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Program</label>
                  <select
                    value={form.program}
                    onChange={(e) => setForm({ ...form, program: e.target.value })}
                    disabled={Boolean(editId)}
                    className="h-10 w-full rounded-md border border-gray-300 px-2 text-sm"
                  >
                    {Object.entries(programs).map(([key, p]) => (
                      <option key={key} value={key}>{p.name}</option>
                    ))}
                  </select>
                </div>
                {form.program === "other" && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Program name</label>
                    <Input value={form.program_name} onChange={(e) => setForm({ ...form, program_name: e.target.value })} required />
                  </div>
                )}
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Whose account</label>
                  <Input value={form.owner_name} onChange={(e) => setForm({ ...form, owner_name: e.target.value })} placeholder="Chad" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Member number</label>
                  <Input value={form.member_number} onChange={(e) => setForm({ ...form, member_number: e.target.value })} />
                </div>
              </div>

              <div className="rounded-lg border border-gray-200 p-3 space-y-3">
                <p className="text-sm font-medium text-gray-700">Automatic sync (optional)</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Username, email or member #</label>
                    <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">
                      Password {editId && "(leave blank to keep the saved one)"}
                    </label>
                    <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.sync_enabled} onChange={(e) => setForm({ ...form, sync_enabled: e.target.checked })} />
                  Sync automatically (about every {days} days)
                </label>
                <p className="text-xs text-gray-500">
                  The password is encrypted on the Mac. Airlines don&apos;t offer a way to read your account, so the app signs
                  in the way you would. Expect a verification code the first time (you&apos;ll get an alert to type it here).
                  After two failed syncs in a row, automatic syncs pause so the airline doesn&apos;t lock the account.
                </p>
                <button type="button" className="text-xs text-blue-600 underline" onClick={() => setAdvanced(!advanced)}>
                  {advanced ? "Hide" : "Show"} website addresses
                </button>
                {advanced && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600">Sign-in page</label>
                      <Input value={form.login_url} onChange={(e) => setForm({ ...form, login_url: e.target.value })} placeholder={chosen?.home_url || "https://"} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600">Page that shows your balance</label>
                      <Input value={form.account_url} onChange={(e) => setForm({ ...form, account_url: e.target.value })} placeholder="https://" />
                    </div>
                  </div>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Balance ({chosen?.unit || "miles"})</label>
                  <Input inputMode="numeric" value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} placeholder="Typed in by hand" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Status</label>
                  <Input list="tier-names" value={form.status_tier} onChange={(e) => setForm({ ...form, status_tier: e.target.value })} placeholder="None" />
                  <datalist id="tier-names">
                    {(chosen?.tiers || []).map((t) => <option key={t} value={t} />)}
                  </datalist>
                </div>
              </div>

              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>{busy ? "Saving..." : "Save"}</Button>
                <Button type="button" variant="outline" onClick={() => { setShowForm(false); setEditId(null); }}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {data.accounts.length === 0 && !showForm ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-gray-500">
            No programs yet. Add one to see your miles and status in one place.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.accounts.map((a) => {
            const p = programs[a.program] || programs.other;
            const name = a.program_name || p.name;
            const active = ACTIVE.includes(a.last_sync_status ?? "") || Boolean(a.sync_requested);
            return (
              <Card key={a.id}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-gray-900">{name}</p>
                      <p className="text-xs text-gray-500">
                        {[a.owner_name, a.member_number && `#${a.member_number}`].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => startEdit(a)}>
                        <Pencil className="h-4 w-4 text-gray-500" />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => remove(a, name)}>
                        <Trash2 className="h-4 w-4 text-gray-500" />
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="text-3xl font-bold text-gray-900">
                        {a.balance === null ? "?" : a.balance.toLocaleString()}
                        <span className="ml-1 text-base font-normal text-gray-500">{a.balance_unit}</span>
                      </p>
                      {a.status_tier && <p className="mt-1 text-sm font-medium text-blue-700">{a.status_tier}</p>}
                      {a.status_detail && <p className="text-xs text-gray-600">{a.status_detail}</p>}
                      {(a.status_expires || a.points_expire) && (
                        <p className="text-xs text-gray-500">
                          {[a.status_expires && `Status through ${a.status_expires}`, a.points_expire && `Miles expire ${a.points_expire}`]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      )}
                    </div>
                    <Sparkline points={a.history} />
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {statusBadge(a)}
                    {a.last_sync_message && a.last_sync_status !== "ok" && (
                      <span className="text-xs text-gray-600">{a.last_sync_message}</span>
                    )}
                  </div>

                  {a.last_sync_status === "needs_code" && a.sync_requested && (
                    <div className="flex gap-2">
                      <Input
                        value={codes[a.id] ?? ""}
                        onChange={(e) => setCodes({ ...codes, [a.id]: e.target.value })}
                        placeholder="Verification code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                      />
                      <Button onClick={() => act(a.id, { action: "code", code: codes[a.id] ?? "" })}>Send code</Button>
                    </div>
                  )}
                  {a.last_sync_status === "waiting_signin" && a.sync_requested && (
                    <p className="text-sm text-gray-700">
                      Chrome is open on the Mac Mini at {p.airline || "the airline"}&apos;s website. Sign in there (in person or
                      with Screen Sharing), then click I&apos;m signed in.
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {active ? (
                      <>
                        {a.last_sync_status === "waiting_signin" && (
                          <Button size="sm" onClick={() => act(a.id, { action: "signed_in" })}>I&apos;m signed in</Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => act(a.id, { action: "cancel" })}>Cancel</Button>
                      </>
                    ) : (
                      <>
                        {(a.has_password || a.last_synced_at) && (
                          <Button size="sm" variant="outline" onClick={() => act(a.id, { action: "sync" })}>
                            <RefreshCw className="mr-1 h-4 w-4" /> Sync now
                          </Button>
                        )}
                        {data.can_sign_in_by_hand && (
                          <Button size="sm" variant="outline" onClick={() => act(a.id, { action: "signin" })}>
                            <KeyRound className="mr-1 h-4 w-4" /> Sign in by hand
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-xs text-gray-500">
        Automatic sync is experimental. Airline websites change often; when a sync can&apos;t find something, screenshots of
        each step are saved in data/captures/loyalty on the Mac. &quot;Sign in by hand&quot; gets past robot checks and app
        approvals, and later syncs reuse that sign-in.
      </p>
    </div>
  );
}
