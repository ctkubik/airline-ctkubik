"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Plane, TrendingDown, ChevronDown, ChevronUp } from "lucide-react";

interface FareWatch {
  id: string;
  name: string;
  origin: string;
  destination: string;
  depart_date_start: string;
  depart_date_end: string;
  return_date_start: string | null;
  return_date_end: string | null;
  adults: number;
  nonstop_only: number;
  max_price: number | null;
  is_active: number;
  created_by: string;
  last_checked_at: string | null;
  last_error: string | null;
  best_price: number | null;
  best_price_currency: string;
  best_departure_date: string | null;
  best_return_date: string | null;
  best_airline: string | null;
}

interface HistoryEntry {
  price: number;
  currency: string;
  departure_date: string | null;
  return_date: string | null;
  airline: string | null;
  checked_at: string;
}

export default function FareWatchesPage() {
  const [watches, setWatches] = useState<FareWatch[]>([]);
  const [providerConfigured, setProviderConfigured] = useState(true);
  const [intervalHours, setIntervalHours] = useState(6);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, HistoryEntry[]>>({});

  // Form state
  const [form, setForm] = useState({
    name: "",
    origin: "",
    destination: "",
    depart_date_start: "",
    depart_date_end: "",
    return_date_start: "",
    return_date_end: "",
    adults: 1,
    nonstop_only: false,
    max_price: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/fare-watches");
    if (res.ok) {
      const data = await res.json();
      setWatches(data.watches);
      setProviderConfigured(data.providerConfigured);
      setIntervalHours(data.checkIntervalHours);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const res = await fetch("/api/fare-watches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setForm({
        name: "", origin: "", destination: "",
        depart_date_start: "", depart_date_end: "",
        return_date_start: "", return_date_end: "",
        adults: 1, nonstop_only: false, max_price: "",
      });
      setShowForm(false);
      await load();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error || "Failed to create fare watch");
    }
    setSubmitting(false);
  }

  async function toggleActive(watch: FareWatch) {
    await fetch(`/api/fare-watches/${watch.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !watch.is_active }),
    });
    await load();
  }

  async function deleteWatch(watch: FareWatch) {
    if (!window.confirm(`Delete fare watch "${watch.name}"?`)) return;
    await fetch(`/api/fare-watches/${watch.id}`, { method: "DELETE" });
    await load();
  }

  async function toggleHistory(watch: FareWatch) {
    if (expanded === watch.id) {
      setExpanded(null);
      return;
    }
    setExpanded(watch.id);
    if (!history[watch.id]) {
      const res = await fetch(`/api/fare-watches/${watch.id}`);
      if (res.ok) {
        const data = await res.json();
        setHistory((h) => ({ ...h, [watch.id]: data.history }));
      }
    }
  }

  function fmtWindow(w: FareWatch): string {
    let s = `${w.depart_date_start} → ${w.depart_date_end}`;
    if (w.return_date_start) {
      s += ` (return ${w.return_date_start} → ${w.return_date_end})`;
    }
    return s;
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Fare Watches</h1>
          <p className="text-sm text-gray-500 mt-1">
            Named searches across all airlines. Each watch is checked every {intervalHours}h and
            you&apos;ll get a notification when the price drops.
          </p>
        </div>
        <Button onClick={() => setShowForm((v) => !v)}>
          <Plus className="h-4 w-4 mr-1" /> New Watch
        </Button>
      </div>

      {!providerConfigured && (
        <div className="rounded-md bg-yellow-50 border border-yellow-200 p-4 text-sm text-yellow-800">
          <strong>Setup needed:</strong> fare watches use the free Amadeus flight-search API.
          Create a free account at{" "}
          <a href="https://developers.amadeus.com" target="_blank" rel="noreferrer" className="underline">
            developers.amadeus.com
          </a>
          , then add <code>AMADEUS_CLIENT_ID</code> and <code>AMADEUS_CLIENT_SECRET</code> to your{" "}
          <code>.env</code> and restart. Watches can be created now; they&apos;ll start checking
          once the keys are set. (Note: Amadeus covers most airlines but not Southwest — Southwest
          fares are tracked on the Flights page.)
        </div>
      )}

      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>New Fare Watch</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="md:col-span-3">
                  <label className="text-xs font-medium text-gray-600">Name</label>
                  <Input
                    placeholder={"e.g. Mom's visit in October"}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">From (airport code)</label>
                  <Input
                    placeholder="MKE"
                    maxLength={3}
                    value={form.origin}
                    onChange={(e) => setForm({ ...form, origin: e.target.value.toUpperCase() })}
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">To (airport code)</label>
                  <Input
                    placeholder="PHX"
                    maxLength={3}
                    value={form.destination}
                    onChange={(e) => setForm({ ...form, destination: e.target.value.toUpperCase() })}
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">Travelers</label>
                  <Input
                    type="number"
                    min={1}
                    max={9}
                    value={form.adults}
                    onChange={(e) => setForm({ ...form, adults: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">Departure window start</label>
                  <Input
                    type="date"
                    value={form.depart_date_start}
                    onChange={(e) => setForm({ ...form, depart_date_start: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">Departure window end</label>
                  <Input
                    type="date"
                    value={form.depart_date_end}
                    onChange={(e) => setForm({ ...form, depart_date_end: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">Alert if under ($, optional)</label>
                  <Input
                    type="number"
                    placeholder="250"
                    value={form.max_price}
                    onChange={(e) => setForm({ ...form, max_price: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">Return window start (optional)</label>
                  <Input
                    type="date"
                    value={form.return_date_start}
                    onChange={(e) => setForm({ ...form, return_date_start: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">Return window end</label>
                  <Input
                    type="date"
                    value={form.return_date_end}
                    onChange={(e) => setForm({ ...form, return_date_end: e.target.value })}
                  />
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={form.nonstop_only}
                      onChange={(e) => setForm({ ...form, nonstop_only: e.target.checked })}
                    />
                    Nonstop only
                  </label>
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Creating…" : "Create Watch"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {watches.map((w) => (
          <Card key={w.id}>
            <CardContent className="pt-6">
              <div className="flex flex-wrap items-center gap-3">
                <Plane className="h-5 w-5 text-blue-600" />
                <div className="min-w-[220px]">
                  <div className="font-semibold text-gray-900">{w.name}</div>
                  <div className="text-xs text-gray-500">
                    {w.origin} → {w.destination} · {fmtWindow(w)}
                    {w.adults > 1 ? ` · ${w.adults} travelers` : ""}
                    {w.nonstop_only ? " · nonstop" : ""}
                  </div>
                </div>
                <Badge variant={w.is_active ? "active" : "inactive"}>
                  {w.is_active ? "watching" : "paused"}
                </Badge>
                {w.best_price !== null && (
                  <div className="flex items-center gap-1 text-green-700 font-semibold">
                    <TrendingDown className="h-4 w-4" />
                    ${w.best_price.toFixed(2)}
                    <span className="text-xs font-normal text-gray-500">
                      {w.best_airline ? ` on ${w.best_airline}` : ""}
                      {w.best_departure_date ? ` · ${w.best_departure_date}` : ""}
                      {w.best_return_date ? ` – ${w.best_return_date}` : ""}
                    </span>
                  </div>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => toggleHistory(w)}>
                    {expanded === w.id ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                    History
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => toggleActive(w)}>
                    {w.is_active ? "Pause" : "Resume"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => deleteWatch(w)}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>
              <div className="mt-2 text-xs text-gray-400">
                {w.last_checked_at
                  ? `Last checked ${new Date(w.last_checked_at + "Z").toLocaleString()}`
                  : "Not checked yet"}
                {w.max_price ? ` · alert under $${w.max_price}` : ""}
                {w.created_by ? ` · created by ${w.created_by}` : ""}
              </div>
              {w.last_error && (
                <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{w.last_error}</div>
              )}
              {expanded === w.id && (
                <div className="mt-4 border-t border-gray-100 pt-3">
                  {(history[w.id] || []).length === 0 ? (
                    <p className="text-sm text-gray-500">No price history yet.</p>
                  ) : (
                    <div className="space-y-1">
                      {(history[w.id] || []).map((h, i) => (
                        <div key={i} className="flex items-center gap-3 text-sm">
                          <span className="text-gray-400 text-xs w-40">
                            {new Date(h.checked_at + "Z").toLocaleString()}
                          </span>
                          <span className="font-medium">${h.price.toFixed(2)}</span>
                          <span className="text-gray-500 text-xs">
                            {h.airline || ""} {h.departure_date || ""}
                            {h.return_date ? ` – ${h.return_date}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
        {watches.length === 0 && !showForm && (
          <Card>
            <CardContent className="pt-6 text-center text-gray-500">
              <p className="mb-3">
                No fare watches yet. Create one for each trip you&apos;re watching — e.g.
                &quot;Grandma&apos;s Christmas visit&quot; or &quot;Spring break to Florida&quot;.
              </p>
              <Button onClick={() => setShowForm(true)}>
                <Plus className="h-4 w-4 mr-1" /> Create your first watch
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
