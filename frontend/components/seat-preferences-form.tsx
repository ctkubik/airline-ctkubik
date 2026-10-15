"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Save } from "lucide-react";

const ALL_SEAT_LETTERS = ["A", "B", "C", "D", "E", "F"];

// Seat and fare-check preferences. Without accountId: the shared set in
// Settings, used by every account that has no set of its own. With
// accountId: that Southwest account's own set (shown inside the Accounts page).
export function SeatPreferencesForm({ accountId, accountName }: { accountId?: string; accountName?: string }) {
  const [preferredLetters, setPreferredLetters] = useState<string[]>(["A", "F"]);
  const [preferredRows, setPreferredRows] = useState("1,2,3,4,5,6");
  const [fallbackLetters, setFallbackLetters] = useState<string[]>(["A", "C", "D", "F"]);
  const [fareCheckMode, setFareCheckMode] = useState("same_day_nonstop");
  const [seatSaved, setSeatSaved] = useState(false);
  const [pickAtCheckin, setPickAtCheckin] = useState(false);
  const [avoidRows, setAvoidRows] = useState("");
  const [minRowGain, setMinRowGain] = useState("0");
  const [custom, setCustom] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchPreferences = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/preferences${accountId ? `?account_id=${encodeURIComponent(accountId)}` : ""}`);
    const data = await res.json();
    setPreferredLetters(data.preferred_letters ? data.preferred_letters.split(",") : []);
    setPreferredRows(data.preferred_rows || "");
    setFallbackLetters(data.fallback_letters ? data.fallback_letters.split(",") : []);
    setFareCheckMode(data.fare_check_mode || "same_day_nonstop");
    setPickAtCheckin(Boolean(data.pick_at_checkin));
    setAvoidRows(data.avoid_rows || "");
    setMinRowGain(String(data.min_row_gain ?? 0));
    setCustom(Boolean(data.custom));
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    fetchPreferences();
  }, [fetchPreferences]);

  async function savePreferences() {
    setSeatSaved(false);
    await fetch("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        preferred_letters: preferredLetters.join(","),
        preferred_rows: preferredRows,
        fallback_letters: fallbackLetters.join(","),
        fare_check_mode: fareCheckMode,
        pick_at_checkin: pickAtCheckin,
        avoid_rows: avoidRows,
        min_row_gain: Number(minRowGain) || 0,
      }),
    });
    if (accountId) setCustom(true);
    setSeatSaved(true);
    setTimeout(() => setSeatSaved(false), 2000);
  }

  async function useShared() {
    if (!accountId) return;
    await fetch(`/api/preferences?account_id=${encodeURIComponent(accountId)}`, { method: "DELETE" });
    await fetchPreferences();
  }

  function toggleLetter(letter: string, list: string[], setList: (v: string[]) => void) {
    if (list.includes(letter)) {
      setList(list.filter((l) => l !== letter));
    } else {
      setList([...list, letter].sort());
    }
  }

  const body = (
    <div className="space-y-4">
      {accountId ? (
        <p className={`rounded-md p-3 text-sm ${custom ? "bg-blue-50 text-blue-800" : "bg-gray-50 text-gray-700"}`}>
          {custom
            ? `${accountName || "This account"} has its own seat and fare-check preferences. They apply to every flight on this account.`
            : `${accountName || "This account"} uses the shared preferences from Settings (shown below). Change anything and save to give this account its own.`}
        </p>
      ) : (
        <p className="text-sm text-gray-500">
          These apply to every Southwest account that doesn&apos;t have its own (set those on the Accounts page, under
          each account&apos;s Seats &amp; fares button). With seat picking on, right after the app checks you in it opens
          the seat map and moves you only if a free seat beats your current one under these preferences, then looks
          again every 3 hours until 2 hours before departure as seats open up. A-List accounts with auto upgrade on
          start 48 hours out. Paid seats (extra legroom, upgrades) are never chosen.
        </p>
      )}

      <label className="flex items-start gap-3 rounded-lg border border-gray-200 p-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={pickAtCheckin}
          onChange={(e) => setPickAtCheckin(e.target.checked)}
        />
        <span>
          <span className="block text-sm font-medium text-gray-900">Pick a better seat at check-in</span>
          <span className="block text-xs text-gray-500">
            {accountId ? "For every flight on this account" : "For every Southwest flight the app checks in"}. Experimental: it drives southwest.com in the
            app&apos;s browser, with the local AI reading the seat map and confirming the change when
            Southwest redesigns a page.
          </span>
        </span>
      </label>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Preferred Seat Letters
        </label>
        <div className="flex gap-2">
          {ALL_SEAT_LETTERS.map((letter) => (
            <button
              key={letter}
              onClick={() => toggleLetter(letter, preferredLetters, setPreferredLetters)}
              className={`w-10 h-10 rounded-md text-sm font-medium border transition-colors ${
                preferredLetters.includes(letter)
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
              }`}
            >
              {letter}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Preferred Rows (comma-separated)
        </label>
        <Input
          value={preferredRows}
          onChange={(e) => setPreferredRows(e.target.value)}
          placeholder="1,2,3,4,5,6"
        />
        <p className="text-xs text-gray-400 mt-1">
          Rows where your preferred letters will be prioritized (e.g., rows 1-6 for front seats)
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Fallback Seat Letters
        </label>
        <div className="flex gap-2">
          {ALL_SEAT_LETTERS.map((letter) => (
            <button
              key={letter}
              onClick={() => toggleLetter(letter, fallbackLetters, setFallbackLetters)}
              className={`w-10 h-10 rounded-md text-sm font-medium border transition-colors ${
                fallbackLetters.includes(letter)
                  ? "bg-orange-500 text-white border-orange-500"
                  : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
              }`}
            >
              {letter}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-1">
          Used when preferred seats in your target rows are not available
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Fare Check Mode
        </label>
        <div className="space-y-2">
          {[
            { value: "same_flight", label: "Same Flight Only", desc: "Only check your exact booked flight for price changes" },
            { value: "same_day_nonstop", label: "Same Day - Nonstop", desc: "Check all nonstop flights on your route that day (recommended)" },
            { value: "same_day", label: "Same Day - All Flights", desc: "Check all flights including connections on your route that day" },
          ].map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                fareCheckMode === opt.value
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-200 hover:bg-gray-50"
              }`}
            >
              <input
                type="radio"
                name="fareCheckMode"
                value={opt.value}
                checked={fareCheckMode === opt.value}
                onChange={(e) => setFareCheckMode(e.target.value)}
                className="mt-0.5"
              />
              <div>
                <div className="text-sm font-medium">{opt.label}</div>
                <div className="text-xs text-gray-400">{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Rows to avoid</label>
          <Input value={avoidRows} onChange={(e) => setAvoidRows(e.target.value)} placeholder="e.g. 29-30" />
          <p className="text-xs text-gray-400 mt-1">Never moved into these (last rows that don&apos;t recline, by the galley)</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Also move forward by</label>
          <Input
            inputMode="numeric"
            value={minRowGain}
            onChange={(e) => setMinRowGain(e.target.value.replace(/\D/g, ""))}
            placeholder="0"
          />
          <p className="text-xs text-gray-400 mt-1">
            Rows. For an equally good seat this many rows closer to the front (0 = only move for a better seat type)
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={savePreferences} disabled={loading}>
          <Save className="mr-2 h-4 w-4" />
          {seatSaved ? "Saved!" : accountId ? `Save ${accountName ? `${accountName}'s` : "these"} preferences` : "Save Preferences"}
        </Button>
        {accountId && custom && (
          <Button variant="outline" onClick={useShared}>
            Use the shared preferences instead
          </Button>
        )}
      </div>
    </div>
  );

  if (accountId) return body;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Seat &amp; Fare Preferences (shared)</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
