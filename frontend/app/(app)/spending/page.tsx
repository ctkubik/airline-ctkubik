"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Group {
  name: string;
  spent: number;
  trips: number;
  points: number;
}

interface Item {
  kind: "trip" | "southwest";
  id: string;
  date: string;
  airline: string;
  traveler: string;
  route: string;
  confirmation_number: string;
  price: number | null;
  points: number | null;
  saved: number;
}

interface Spending {
  year: string;
  years: string[];
  totals: { spent: number; saved: number; points: number; trips: number; upcoming: number; missing_price: number };
  by_airline: Group[];
  by_traveler: Group[];
  items: Item[];
}

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function Bars({ groups, total }: { groups: Group[]; total: number }) {
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.name}>
          <div className="flex justify-between text-sm">
            <span className="font-medium text-gray-800">{g.name}</span>
            <span className="text-gray-600">
              {money(g.spent)} · {g.trips} trip{g.trips === 1 ? "" : "s"}
              {g.points ? ` · ${g.points.toLocaleString()} pts` : ""}
            </span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-gray-100">
            <div className="h-2 rounded-full bg-blue-500" style={{ width: `${total ? Math.max(2, (g.spent / total) * 100) : 0}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SpendingPage() {
  const [data, setData] = useState<Spending | null>(null);
  const [year, setYear] = useState<string>("");

  const load = useCallback(async (y: string) => {
    const res = await fetch(`/api/spending${y ? `?year=${y}` : ""}`);
    if (res.ok) {
      const body = (await res.json()) as Spending;
      setData(body);
      setYear(body.year);
    }
  }, []);

  useEffect(() => {
    load("");
  }, [load]);

  if (!data) return <div className="text-sm text-gray-500">Loading...</div>;
  const t = data.totals;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Spending</h1>
          <p className="mt-1 text-sm text-gray-500">What you paid for flights on every airline, by year, airline and traveler.</p>
        </div>
        <select
          value={year}
          onChange={(e) => load(e.target.value)}
          className="h-10 rounded-md border border-gray-300 px-3 text-sm"
          aria-label="Year"
        >
          {data.years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
          <option value="all">All years</option>
        </select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">Spent</p>
            <p className="text-2xl font-bold text-gray-900">{money(t.spent)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">Trips</p>
            <p className="text-2xl font-bold text-gray-900">{t.trips}</p>
            {t.upcoming > 0 && <p className="text-xs text-gray-500">{t.upcoming} still ahead</p>}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">Average per trip</p>
            <p className="text-2xl font-bold text-gray-900">
              {t.trips - t.missing_price > 0 ? money(t.spent / (t.trips - t.missing_price)) : "n/a"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">Saved by rebooking</p>
            <p className="text-2xl font-bold text-green-700">{money(t.saved)}</p>
            {t.points > 0 && <p className="text-xs text-gray-500">{t.points.toLocaleString()} miles/points used</p>}
          </CardContent>
        </Card>
      </div>

      {t.missing_price > 0 && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
          {t.missing_price} trip{t.missing_price === 1 ? " has" : "s have"} no price yet. Add it on the{" "}
          <Link href="/flights" className="underline">Flights</Link> page (Southwest) or{" "}
          <Link href="/trips" className="underline">Other Airlines</Link>.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>By airline</CardTitle></CardHeader>
          <CardContent>
            {data.by_airline.length ? <Bars groups={data.by_airline} total={t.spent} /> : <p className="text-sm text-gray-500">No trips yet.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>By traveler</CardTitle></CardHeader>
          <CardContent>
            {data.by_traveler.length ? <Bars groups={data.by_traveler} total={t.spent} /> : <p className="text-sm text-gray-500">No trips yet.</p>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Trips</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Airline</th>
                <th className="py-2 pr-3 font-medium">Route</th>
                <th className="py-2 pr-3 font-medium">Traveler</th>
                <th className="py-2 pr-3 font-medium">Conf #</th>
                <th className="py-2 text-right font-medium">Paid</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={`${i.kind}-${i.id}`} className="border-b last:border-0">
                  <td className="py-2 pr-3 whitespace-nowrap">{i.date}</td>
                  <td className="py-2 pr-3">{i.airline}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{i.route}</td>
                  <td className="py-2 pr-3">{i.traveler}</td>
                  <td className="py-2 pr-3 font-mono">{i.confirmation_number}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {i.price !== null ? `$${i.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : <span className="text-amber-700">add price</span>}
                    {i.points ? <div className="text-xs text-gray-500">{i.points.toLocaleString()} pts</div> : null}
                    {i.saved > 0 ? <div className="text-xs text-green-700">saved {money(i.saved)}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
