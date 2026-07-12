"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, MapPin, Plane, X } from "lucide-react";

interface Leg {
  id: string;
  flight_number: string | null;
  airline: string | null;
  departure_airport: string;
  destination_airport: string;
  departure_time: string;
  checkin_status: string;
  auto_checkin: number | null;
  flight_status: string | null;
  flight_status_detail: string | null;
  original_price: number | null;
  original_currency: string | null;
  confirmation_number: string;
  first_name: string;
  last_name: string;
}

interface Trip {
  id: string;
  name: string;
  destination: string;
  start_date: string | null;
  end_date: string | null;
  notes: string;
  owner_username: string | null;
  owner_display_name: string | null;
  legs: Leg[];
  total_cost: number;
  total_currency: string;
}

interface AssignableFlight {
  id: string;
  trip_id: string | null;
  airline: string | null;
  flight_number: string | null;
  departure_airport: string;
  destination_airport: string;
  departure_time: string;
}

const carrierLabel = (l: { airline: string | null; flight_number: string | null }) =>
  l.airline
    ? `${l.airline} ${l.flight_number ?? ""}`.trim()
    : String(l.flight_number || "").replace(/^WN/, "WN ");

function fmtDate(s: string | null, opts?: Intl.DateTimeFormatOptions) {
  if (!s) return "";
  const d = new Date(s.length <= 10 ? s + "T00:00:00" : s);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, opts || { month: "short", day: "numeric" });
}

export default function TripsPage() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [flights, setFlights] = useState<AssignableFlight[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: "", destination: "", start_date: "", end_date: "", notes: "" });

  const load = useCallback(async () => {
    const [tRes, fRes] = await Promise.all([fetch("/api/trips"), fetch("/api/flights")]);
    if (tRes.ok) {
      const data = await tRes.json();
      setTrips(data.trips);
      setIsAdmin(!!data.isAdmin);
    }
    if (fRes.ok) setFlights(await fRes.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Flights not yet assigned to any trip — offered in each trip's "add leg" picker.
  const unassigned = useMemo(() => flights.filter((f) => !f.trip_id), [flights]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const res = await fetch("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setForm({ name: "", destination: "", start_date: "", end_date: "", notes: "" });
      setShowForm(false);
      await load();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error || "Could not create trip");
    }
    setSubmitting(false);
  }

  async function attachLeg(tripId: string, flightId: string) {
    if (!flightId) return;
    await fetch(`/api/trips/${tripId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attach_flight: flightId }),
    });
    await load();
  }

  async function detachLeg(tripId: string, flightId: string) {
    await fetch(`/api/trips/${tripId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ detach_flight: flightId }),
    });
    await load();
  }

  async function deleteTrip(t: Trip) {
    if (!window.confirm(`Delete the trip "${t.name}"? Its flights stay tracked.`)) return;
    await fetch(`/api/trips/${t.id}`, { method: "DELETE" });
    await load();
  }

  function tripDates(t: Trip): string {
    const start = t.start_date || (t.legs[0]?.departure_time ?? null);
    const end = t.end_date || (t.legs[t.legs.length - 1]?.departure_time ?? null);
    if (!start) return "Dates TBD";
    const s = fmtDate(start, { month: "short", day: "numeric" });
    const e = end ? fmtDate(end, { month: "short", day: "numeric", year: "numeric" }) : "";
    return e && e !== s ? `${s} – ${e}` : fmtDate(start, { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="eyebrow mb-1">Travel</div>
          <h1 className="text-[28px] font-semibold tracking-tight">Trips</h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">
            Group a journey&apos;s flights — even across airlines, like Southwest out and Delta
            back — into one timeline with a running total.
            {isAdmin && " As admin you see every member's trips; each member sees only their own."}
          </p>
        </div>
        <Button onClick={() => setShowForm((v) => !v)}>
          <Plus className="h-4 w-4" /> New Trip
        </Button>
      </header>

      {error && (
        <div className="rounded-[var(--radius-sm)] bg-[color:var(--danger-tint)] p-3 text-sm text-[color:var(--danger)]">
          {error}
        </div>
      )}

      {showForm && (
        <Card>
          <CardContent className="pt-5">
            <div className="mb-3 font-display text-[15px] font-semibold">New trip</div>
            <form onSubmit={handleCreate} className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="eyebrow mb-1 block">Name</label>
                <Input
                  placeholder="e.g. Spring break — Orlando"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="eyebrow mb-1 block">Destination (optional)</label>
                <Input
                  placeholder="e.g. Orlando, FL"
                  value={form.destination}
                  onChange={(e) => setForm({ ...form, destination: e.target.value })}
                />
              </div>
              <div />
              <div>
                <label className="eyebrow mb-1 block">Start date (optional)</label>
                <Input
                  type="date"
                  value={form.start_date}
                  onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                />
              </div>
              <div>
                <label className="eyebrow mb-1 block">End date (optional)</label>
                <Input
                  type="date"
                  value={form.end_date}
                  onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                />
              </div>
              <div>
                <label className="eyebrow mb-1 block">Notes (optional)</label>
                <Input
                  placeholder="e.g. staying at the Hyatt"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </div>
              <div className="flex gap-2 md:col-span-3">
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Creating…" : "Create Trip"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {trips.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-[color:var(--muted)]">
            No trips yet. Create one, then attach the flights that belong to it — across any airline —
            to see the whole journey and its total cost in one place.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {trips.map((t) => (
            <Card key={t.id} className="overflow-hidden">
              <CardContent className="pt-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-display text-[18px] font-semibold tracking-tight">{t.name}</h2>
                      {t.destination && (
                        <span className="flex items-center gap-1 text-[13px] text-[color:var(--muted)]">
                          <MapPin className="h-3.5 w-3.5" /> {t.destination}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[13px] text-[color:var(--muted)]">
                      {tripDates(t)} · {t.legs.length} {t.legs.length === 1 ? "flight" : "flights"}
                      {isAdmin && (
                        <span className="ml-2 text-[color:var(--faint)]">
                          · {t.owner_display_name || t.owner_username || "—"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {t.total_cost > 0 && (
                      <div className="text-right">
                        <div className="eyebrow">Total</div>
                        <div className="font-mono text-[16px] font-semibold text-[color:var(--ink)]">
                          ${t.total_cost.toLocaleString()}
                        </div>
                      </div>
                    )}
                    <Button variant="outline" size="sm" onClick={() => deleteTrip(t)}>
                      <Trash2 className="h-4 w-4 text-[color:var(--danger)]" />
                    </Button>
                  </div>
                </div>

                {t.notes && <p className="mt-2 text-[13px] text-[color:var(--muted)]">{t.notes}</p>}

                {/* Timeline of legs */}
                {t.legs.length > 0 && (
                  <ol className="mt-4 space-y-0">
                    {t.legs.map((l, i) => (
                      <li key={l.id} className="relative flex gap-3 pb-4 last:pb-0">
                        {/* Rail */}
                        <div className="flex flex-col items-center">
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[color:var(--accent-tint)]">
                            <Plane className="h-3.5 w-3.5 -rotate-45 text-[color:var(--accent-hover)]" />
                          </span>
                          {i < t.legs.length - 1 && (
                            <span className="mt-1 w-px flex-1 bg-[color:var(--line-strong)]" aria-hidden />
                          )}
                        </div>
                        <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
                          <span className="font-mono text-[15px] font-semibold tracking-tight">
                            {l.departure_airport} <span className="text-[color:var(--accent)]">→</span>{" "}
                            {l.destination_airport}
                          </span>
                          <span className="font-mono text-xs text-[color:var(--faint)]">
                            {carrierLabel(l)}
                          </span>
                          <span className="text-[13px] text-[color:var(--muted)]">
                            {new Date(l.departure_time).toLocaleDateString(undefined, {
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                            })}
                            {" · "}
                            {new Date(l.departure_time).toLocaleTimeString(undefined, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          {l.auto_checkin === 0 ? (
                            <Badge variant="default">Tracked</Badge>
                          ) : (
                            <Badge variant={l.checkin_status === "success" ? "active" : "default"}>
                              {l.checkin_status === "success" ? "Checked in" : "Auto check-in"}
                            </Badge>
                          )}
                          {l.original_price ? (
                            <span className="font-mono text-[13px] text-[color:var(--ink-soft)]">
                              ${l.original_price.toLocaleString()}
                            </span>
                          ) : null}
                          <button
                            onClick={() => detachLeg(t.id, l.id)}
                            className="ml-auto text-[color:var(--faint)] hover:text-[color:var(--danger)]"
                            title="Remove from trip"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}

                {/* Add a leg */}
                {unassigned.length > 0 && (
                  <div className="mt-4 flex items-center gap-2 border-t border-[color:var(--line)] pt-3">
                    <label className="eyebrow">Add a flight</label>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        attachLeg(t.id, e.target.value);
                        e.target.value = "";
                      }}
                      className="h-9 rounded-[var(--radius-sm)] border border-[color:var(--line-strong)] bg-[color:var(--surface)] px-3 text-sm"
                    >
                      <option value="">Pick a tracked flight…</option>
                      {unassigned.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.departure_airport} → {f.destination_airport} · {carrierLabel(f)} ·{" "}
                          {new Date(f.departure_time).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
