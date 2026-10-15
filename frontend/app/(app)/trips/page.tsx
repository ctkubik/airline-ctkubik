"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mail, Pencil, Plus, Trash2 } from "lucide-react";
import { TripForm, emptyTrip, type LoyaltyOption, type TripDraft } from "@/components/trips/trip-form";

interface Segment {
  airline_code: string;
  flight_number: string;
  departure_airport: string;
  destination_airport: string;
  departure_local: string;
  arrival_local: string | null;
  seat: string;
}

interface Trip {
  id: string;
  airline: string;
  confirmation_number: string;
  traveler: string;
  price_paid: number | null;
  currency: string;
  points_used: number | null;
  cabin: string;
  notes: string;
  loyalty_account_id: string | null;
  status: string;
  source: string;
  segments: Segment[];
  first_departure: string | null;
}

interface FoundTrip {
  airline: string;
  confirmation_number: string;
  traveler: string;
  price_paid: number | null;
  currency: string;
  points_used: number | null;
  cabin: string;
  segments: { flight_number: string; departure_airport: string; destination_airport: string; departure_local: string; arrival_local: string }[];
  southwest: boolean;
  already_added: boolean;
}

function fmtLocal(local: string): string {
  const [d, t] = local.split("T");
  const date = new Date(`${d}T12:00:00`);
  const day = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  if (!t) return day;
  const [h, m] = t.split(":").map(Number);
  return `${day}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function toDraft(t: Trip): TripDraft {
  return {
    id: t.id,
    airline: t.airline,
    confirmation_number: t.confirmation_number,
    traveler: t.traveler,
    price_paid: t.price_paid === null ? "" : String(t.price_paid),
    currency: t.currency,
    points_used: t.points_used === null ? "" : String(t.points_used),
    cabin: t.cabin,
    notes: t.notes,
    loyalty_account_id: t.loyalty_account_id ?? "",
    status: t.status,
    segments: t.segments.map((s) => ({
      flight_number: s.flight_number ? `${s.airline_code}${s.flight_number}` : "",
      departure_airport: s.departure_airport,
      destination_airport: s.destination_airport,
      departure_local: s.departure_local,
      arrival_local: s.arrival_local ?? "",
    })),
  };
}

function foundToDraft(f: FoundTrip): TripDraft {
  return {
    ...emptyTrip(),
    airline: f.airline,
    confirmation_number: f.confirmation_number,
    traveler: f.traveler,
    price_paid: f.price_paid === null ? "" : String(f.price_paid),
    currency: f.currency,
    points_used: f.points_used === null ? "" : String(f.points_used),
    cabin: f.cabin,
    source: "email",
    segments: f.segments.length ? f.segments : emptyTrip().segments,
  };
}

export default function TripsPage() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loyalty, setLoyalty] = useState<LoyaltyOption[]>([]);
  const [editing, setEditing] = useState<TripDraft | null>(null);
  const [showPast, setShowPast] = useState(false);
  // Email import
  const [importing, setImporting] = useState(false);
  const [emailText, setEmailText] = useState("");
  const [found, setFound] = useState<FoundTrip[] | null>(null);
  const [source, setSource] = useState<"llm" | "pattern" | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [t, l] = await Promise.all([fetch("/api/trips"), fetch("/api/loyalty")]);
    if (t.ok) setTrips(await t.json());
    if (l.ok) {
      const data = await l.json();
      setLoyalty(
        (data.accounts as { id: string; program: string; program_name: string; owner_name: string }[]).map((a) => ({
          id: a.id,
          label: `${a.program_name || data.programs[a.program]?.name || a.program}${a.owner_name ? ` (${a.owner_name})` : ""}`,
        }))
      );
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function readEmail() {
    setReading(true);
    setError("");
    const res = await fetch("/api/trips/parse-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: emailText }),
    });
    const body = await res.json().catch(() => null);
    setReading(false);
    if (!res.ok) {
      setError(body?.error || "Couldn't read that email");
      return;
    }
    setFound(body.trips);
    setSource(body.source);
  }

  function closeImport() {
    setImporting(false);
    setEmailText("");
    setFound(null);
    setSource(null);
    setError("");
  }

  async function remove(t: Trip) {
    if (!window.confirm(`Delete the ${t.airline} trip ${t.confirmation_number}?`)) return;
    await fetch(`/api/trips/${t.id}`, { method: "DELETE" });
    load();
  }

  const now = new Date().toISOString().slice(0, 16);
  const lastLocal = (t: Trip) => t.segments[t.segments.length - 1]?.departure_local ?? "";
  const upcoming = trips.filter((t) => lastLocal(t) >= now.slice(0, 10));
  const past = trips.filter((t) => lastLocal(t) < now.slice(0, 10)).reverse();
  const shown = showPast ? past : upcoming;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Other Airlines</h1>
          <p className="mt-1 text-sm text-gray-500">
            Trips on any airline, for your calendar feed and spending. The app doesn&apos;t check in for these.
            Southwest trips go on the <Link href="/reservations" className="text-blue-600 underline">Reservations</Link> page.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => { setEditing(null); setImporting(true); }}>
            <Mail className="mr-2 h-4 w-4" /> Add from email
          </Button>
          <Button onClick={() => { closeImport(); setEditing(emptyTrip()); }}>
            <Plus className="mr-2 h-4 w-4" /> Add trip
          </Button>
        </div>
      </div>

      {importing && !editing && (
        <Card>
          <CardHeader>
            <CardTitle>Add from a confirmation email</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {found === null ? (
              <>
                <p className="text-sm text-gray-600">
                  Open the airline&apos;s confirmation or receipt email, select all of it, copy, and paste it here.
                </p>
                <textarea
                  value={emailText}
                  onChange={(e) => setEmailText(e.target.value)}
                  rows={10}
                  className="w-full rounded-md border border-gray-300 p-3 text-sm"
                  placeholder="Paste the whole email here"
                />
                {error && <p className="text-sm text-red-700">{error}</p>}
                <div className="flex gap-2">
                  <Button onClick={readEmail} disabled={reading || !emailText.trim()}>
                    {reading ? "Reading..." : "Find trips"}
                  </Button>
                  <Button variant="outline" onClick={closeImport}>Cancel</Button>
                </div>
              </>
            ) : (
              <>
                {found.length === 0 ? (
                  <p className="text-sm text-gray-700">
                    No confirmation numbers found. Make sure you pasted the whole email, or add the trip by hand.
                  </p>
                ) : (
                  <p className="text-sm text-gray-600">
                    {source === "llm"
                      ? "Found these. Review each one and save it."
                      : "Found these confirmation numbers. The local AI is off, so add the flights when you review each one."}
                  </p>
                )}
                {found.map((f) => (
                  <div key={f.confirmation_number} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 p-3">
                    <div className="text-sm">
                      <span className="font-medium">{f.airline || "Airline?"} {f.confirmation_number}</span>
                      {f.segments.length > 0 && (
                        <span className="ml-2 text-gray-500">
                          {f.segments.map((s) => s.departure_airport).concat(f.segments[f.segments.length - 1].destination_airport).join(" → ")}
                        </span>
                      )}
                      {f.price_paid !== null && <span className="ml-2 text-gray-500">${f.price_paid.toFixed(2)}</span>}
                      {f.already_added && <span className="ml-2 text-xs text-amber-700">already added</span>}
                    </div>
                    {f.already_added ? (
                      <span className="text-xs text-gray-500">Saved</span>
                    ) : f.southwest ? (
                      <span className="text-xs text-gray-600">
                        Southwest: add it on <Link href="/reservations" className="text-blue-600 underline">Reservations</Link> so the app checks you in
                      </span>
                    ) : (
                      <Button size="sm" onClick={() => setEditing(foundToDraft(f))}>Review and save</Button>
                    )}
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setFound(null)}>Back</Button>
                  <Button variant="outline" onClick={closeImport}>Done</Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {editing && (
        <Card>
          <CardHeader>
            <CardTitle>{editing.id ? "Edit trip" : "New trip"}</CardTitle>
          </CardHeader>
          <CardContent>
            <TripForm
              key={editing.id ?? editing.confirmation_number ?? "new"}
              initial={editing}
              loyalty={loyalty}
              onSaved={() => {
                if (editing.source === "email" && found) {
                  setFound(found.map((f) => (f.confirmation_number === editing.confirmation_number ? { ...f, already_added: true } : f)));
                }
                setEditing(null);
                load();
              }}
              onCancel={() => setEditing(null)}
            />
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2">
        <Button variant={showPast ? "outline" : "default"} size="sm" onClick={() => setShowPast(false)}>
          Upcoming ({upcoming.length})
        </Button>
        <Button variant={showPast ? "default" : "outline"} size="sm" onClick={() => setShowPast(true)}>
          Past ({past.length})
        </Button>
      </div>

      {shown.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-gray-500">
            {showPast ? "No past trips yet." : "No upcoming trips on other airlines. Add one, or paste a confirmation email."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((t) => (
            <Card key={t.id} className={t.status === "cancelled" ? "opacity-60" : ""}>
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-gray-900">{t.airline}</span>
                    {t.confirmation_number && <span className="font-mono text-sm text-gray-600">{t.confirmation_number}</span>}
                    {t.traveler && <span className="text-sm text-gray-600">{t.traveler}</span>}
                    {t.status === "cancelled" && <Badge variant="inactive">Cancelled</Badge>}
                  </div>
                  <div className="flex items-center gap-1">
                    {t.price_paid !== null && (
                      <span className="mr-2 text-sm font-medium text-gray-900">
                        ${t.price_paid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    )}
                    {t.points_used ? <span className="mr-2 text-sm text-gray-600">{t.points_used.toLocaleString()} pts</span> : null}
                    <Button variant="ghost" size="icon" aria-label="Edit trip" onClick={() => { closeImport(); setEditing(toDraft(t)); }}>
                      <Pencil className="h-4 w-4 text-gray-500" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="Delete trip" onClick={() => remove(t)}>
                      <Trash2 className="h-4 w-4 text-gray-500" />
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  {t.segments.map((s, i) => (
                    <div key={i} className="flex flex-wrap gap-x-3 text-sm text-gray-700">
                      <span className="w-20 font-mono text-gray-500">{s.flight_number ? `${s.airline_code} ${s.flight_number}` : ""}</span>
                      <span className="w-28 font-medium">{s.departure_airport} → {s.destination_airport}</span>
                      <span>{fmtLocal(s.departure_local)}</span>
                    </div>
                  ))}
                </div>
                {(t.cabin || t.notes) && (
                  <p className="text-xs text-gray-500">{[t.cabin, t.notes].filter(Boolean).join(" · ")}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
