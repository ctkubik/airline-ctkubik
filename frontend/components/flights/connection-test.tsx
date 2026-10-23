"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, PlugZap, XCircle } from "lucide-react";

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

interface Result {
  done: boolean;
  ok?: boolean;
  queued?: boolean;
  steps: Step[];
  checked_at?: string;
}

// "Test check-in connection": asks the worker to prove both check-in paths
// (the phone-app service and the southwest.com backup) work for this flight
// right now, without checking anyone in. Results arrive within a minute or two.
export function ConnectionTest({ flightId }: { flightId: string }) {
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function poll() {
    const res = await fetch(`/api/flights/test-connection?flight_id=${encodeURIComponent(flightId)}`);
    const body = (await res.json().catch(() => null)) as Result | null;
    setResult(body);
    if (body?.done && timer.current) {
      clearInterval(timer.current);
      timer.current = null;
      setRunning(false);
    }
  }

  useEffect(() => {
    poll();
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightId]);

  async function start() {
    setRunning(true);
    await fetch("/api/flights/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flight_id: flightId }),
    });
    await poll();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(poll, 3000);
  }

  const busy = running || (result !== null && !result.done);

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className="text-xs" onClick={start} disabled={busy}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <PlugZap className="mr-1 h-3.5 w-3.5" />}
          {busy ? "Testing..." : "Test check-in connection"}
        </Button>
        {result?.done && (
          <span className={`text-xs font-medium ${result.ok ? "text-green-700" : "text-red-700"}`}>
            {result.ok ? "Both check-in paths work" : "Something needs attention"}
            {result.checked_at && ` · ${new Date(result.checked_at).toLocaleString()}`}
          </span>
        )}
        {busy && (
          <span className="text-xs text-gray-500">
            {result?.queued && !result.steps.length ? "Waiting for the worker (up to a minute)..." : "Running..."}
          </span>
        )}
      </div>
      {result && result.steps.length > 0 && (
        <ul className="space-y-1 rounded-md border border-gray-200 bg-gray-50 p-2 text-xs">
          {result.steps.map((s) => (
            <li key={s.name} className="flex items-start gap-2">
              {s.ok ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
              ) : (
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
              )}
              <span>
                <b>{s.name}:</b> {s.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
