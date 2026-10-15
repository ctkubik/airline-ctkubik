"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Trash2 } from "lucide-react";
import { AIRLINES } from "@/lib/airlines";

export interface SegmentDraft {
  flight_number: string;
  departure_airport: string;
  destination_airport: string;
  departure_local: string;
  arrival_local: string;
  seat?: string;
}

export interface TripDraft {
  id?: string;
  airline: string;
  confirmation_number: string;
  traveler: string;
  price_paid: string;
  currency: string;
  points_used: string;
  cabin: string;
  notes: string;
  loyalty_account_id: string;
  status: string;
  source?: string;
  segments: SegmentDraft[];
}

export interface LoyaltyOption {
  id: string;
  label: string;
}

export const emptySegment = (): SegmentDraft => ({
  flight_number: "",
  departure_airport: "",
  destination_airport: "",
  departure_local: "",
  arrival_local: "",
});

export const emptyTrip = (): TripDraft => ({
  airline: "",
  confirmation_number: "",
  traveler: "",
  price_paid: "",
  currency: "USD",
  points_used: "",
  cabin: "",
  notes: "",
  loyalty_account_id: "",
  status: "booked",
  segments: [emptySegment()],
});

const label = "block text-xs font-medium text-gray-600 mb-1";

// Add or edit a trip on any airline. Saving POSTs (new) or PATCHes (edit).
export function TripForm({
  initial,
  loyalty,
  onSaved,
  onCancel,
}: {
  initial: TripDraft;
  loyalty: LoyaltyOption[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [trip, setTrip] = useState<TripDraft>(initial);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<TripDraft>) => setTrip((t) => ({ ...t, ...patch }));
  const setSeg = (i: number, patch: Partial<SegmentDraft>) =>
    setTrip((t) => ({ ...t, segments: t.segments.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    const res = await fetch(trip.id ? `/api/trips/${trip.id}` : "/api/trips", {
      method: trip.id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trip),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error || "Couldn't save the trip");
      return;
    }
    onSaved();
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label}>Airline</label>
          <Input
            list="airline-names"
            value={trip.airline}
            onChange={(e) => set({ airline: e.target.value })}
            placeholder="Delta"
            required
          />
          <datalist id="airline-names">
            {AIRLINES.filter((a) => a.code !== "WN").map((a) => (
              <option key={a.code} value={a.name} />
            ))}
          </datalist>
        </div>
        <div>
          <label className={label}>Confirmation #</label>
          <Input
            value={trip.confirmation_number}
            onChange={(e) => set({ confirmation_number: e.target.value.toUpperCase() })}
            placeholder="ABC123"
          />
        </div>
        <div>
          <label className={label}>Traveler(s)</label>
          <Input value={trip.traveler} onChange={(e) => set({ traveler: e.target.value })} placeholder="Chad Kubik" />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-700">Flights</p>
        {trip.segments.map((s, i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-gray-200 p-3 sm:grid-cols-12">
            <div className="sm:col-span-2">
              <label className={label}>Flight #</label>
              <Input
                value={s.flight_number}
                onChange={(e) => setSeg(i, { flight_number: e.target.value.toUpperCase() })}
                placeholder="DL1234"
              />
            </div>
            <div className="sm:col-span-2">
              <label className={label}>From</label>
              <Input
                value={s.departure_airport}
                onChange={(e) => setSeg(i, { departure_airport: e.target.value.toUpperCase().slice(0, 3) })}
                placeholder="PHX"
                required
              />
            </div>
            <div className="sm:col-span-2">
              <label className={label}>To</label>
              <Input
                value={s.destination_airport}
                onChange={(e) => setSeg(i, { destination_airport: e.target.value.toUpperCase().slice(0, 3) })}
                placeholder="ATL"
                required
              />
            </div>
            <div className="sm:col-span-3">
              <label className={label}>Departs (local time)</label>
              <Input
                type="datetime-local"
                value={s.departure_local}
                onChange={(e) => setSeg(i, { departure_local: e.target.value })}
                required
              />
            </div>
            <div className="sm:col-span-2">
              <label className={label}>Arrives</label>
              <Input
                type="datetime-local"
                value={s.arrival_local}
                onChange={(e) => setSeg(i, { arrival_local: e.target.value })}
              />
            </div>
            <div className="flex items-end sm:col-span-1">
              {trip.segments.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove flight"
                  onClick={() => set({ segments: trip.segments.filter((_, j) => j !== i) })}
                >
                  <Trash2 className="h-4 w-4 text-gray-500" />
                </Button>
              )}
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => set({ segments: [...trip.segments, emptySegment()] })}
        >
          <Plus className="mr-1 h-4 w-4" /> Add a flight
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={label}>Price paid ($)</label>
          <Input
            inputMode="decimal"
            value={trip.price_paid}
            onChange={(e) => set({ price_paid: e.target.value })}
            placeholder="412.80"
          />
        </div>
        <div>
          <label className={label}>Miles / points used</label>
          <Input
            inputMode="numeric"
            value={trip.points_used}
            onChange={(e) => set({ points_used: e.target.value })}
            placeholder="0"
          />
        </div>
        <div>
          <label className={label}>Cabin</label>
          <Input value={trip.cabin} onChange={(e) => set({ cabin: e.target.value })} placeholder="Main Cabin" />
        </div>
        <div>
          <label className={label}>Earns miles in</label>
          <select
            value={trip.loyalty_account_id}
            onChange={(e) => set({ loyalty_account_id: e.target.value })}
            className="h-10 w-full rounded-md border border-gray-300 px-2 text-sm"
          >
            <option value="">None</option>
            {loyalty.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-3">
          <label className={label}>Notes</label>
          <Input value={trip.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Conference in Atlanta" />
        </div>
        {trip.id && (
          <div>
            <label className={label}>Status</label>
            <select
              value={trip.status}
              onChange={(e) => set({ status: e.target.value })}
              className="h-10 w-full rounded-md border border-gray-300 px-2 text-sm"
            >
              <option value="booked">Booked</option>
              <option value="cancelled">Cancelled (leave out of spending)</option>
            </select>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : trip.id ? "Save changes" : "Save trip"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
