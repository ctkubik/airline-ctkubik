"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Loader2, Plus, RefreshCw } from "lucide-react";

// For a manual reservation: where the flight lookup stands, a "Try again"
// button, and a form to add a flight by hand so the check-in is scheduled
// even when the app can't look the reservation up.
export function FlightLookup({
  reservationId,
  status,
  message,
  hasFlights,
  onChanged,
}: {
  reservationId: string;
  status: string | null | undefined;
  message: string | null | undefined;
  hasFlights: boolean;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ flight_number: "", departure_airport: "", destination_airport: "", departure_local: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function retry() {
    await fetch(`/api/reservations/${reservationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry" }),
    });
    onChanged();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch(`/api/reservations/${reservationId}/flights`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error || "Couldn't add the flight");
      return;
    }
    setForm({ flight_number: "", departure_airport: "", destination_airport: "", departure_local: "" });
    setAdding(false);
    onChanged();
  }

  const waiting = !status || status === "pending";
  const failed = status === "error";
  if (hasFlights && !failed && !adding) {
    return (
      <div className="px-4 pb-3 text-xs text-gray-500">
        <button className="text-blue-600 underline" onClick={() => setAdding(true)}>
          Add a flight by hand
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-gray-100 px-4 py-3 text-sm" onClick={(e) => e.stopPropagation()}>
      {!hasFlights && waiting && (
        <p className="flex items-center gap-2 text-gray-600">
          <Loader2 className="h-4 w-4 animate-spin" /> Looking up the flights with Southwest (within a minute or two)...
        </p>
      )}
      {failed && (
        <p className="flex items-start gap-2 text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {failed && (
          <Button size="sm" variant="outline" onClick={retry}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> Try again now
          </Button>
        )}
        {!adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add the flight by hand
          </Button>
        )}
      </div>
      {adding && (
        <form onSubmit={add} className="space-y-2 rounded-md border border-gray-200 bg-white p-3">
          <p className="text-xs text-gray-500">
            From your confirmation email. Add each flight (each direction) separately. The app checks you in{" "}
            {"24 hours before (48 for A-List)"} using the departure time at the departure airport.
          </p>
          <div className="grid gap-2 sm:grid-cols-4">
            <Input
              placeholder="Flight # (1234)"
              value={form.flight_number}
              onChange={(e) => setForm({ ...form, flight_number: e.target.value })}
              required
            />
            <Input
              placeholder="From (PHX)"
              value={form.departure_airport}
              onChange={(e) => setForm({ ...form, departure_airport: e.target.value.toUpperCase().slice(0, 3) })}
              required
            />
            <Input
              placeholder="To (MDW)"
              value={form.destination_airport}
              onChange={(e) => setForm({ ...form, destination_airport: e.target.value.toUpperCase().slice(0, 3) })}
              required
            />
            <Input
              type="datetime-local"
              value={form.departure_local}
              onChange={(e) => setForm({ ...form, departure_local: e.target.value })}
              aria-label="Departure (local time)"
              required
            />
          </div>
          {error && <p className="text-xs text-red-700">{error}</p>}
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={busy}>
              {busy ? "Adding..." : "Add flight"}
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
