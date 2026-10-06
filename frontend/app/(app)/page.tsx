"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/flights/status-badge";
import { CountdownTimer } from "@/components/flights/countdown-timer";
import { Users, CalendarCheck, Plane, CheckCircle, XCircle, AlertTriangle, ShieldCheck } from "lucide-react";
import type { DashboardStats, Flight, WorkerLog } from "@/lib/types";

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [upcomingFlights, setUpcomingFlights] = useState<Flight[]>([]);
  const [recentLogs, setRecentLogs] = useState<WorkerLog[]>([]);
  const [systemProblem, setSystemProblem] = useState<string | null>(null);
  const [savings, setSavings] = useState<{
    drops_found: number;
    flights_with_drops: number;
    claimed: number;
    flights_claimed: number;
  } | null>(null);

  useEffect(() => {
    fetchDashboard();
    let interval = setInterval(fetchDashboard, 60000);

    function handleVisibility() {
      clearInterval(interval);
      if (document.visibilityState === "visible") {
        fetchDashboard();
        interval = setInterval(fetchDashboard, 60000);
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  async function fetchDashboard() {
    const res = await fetch("/api/dashboard");
    const data = await res.json();
    setStats(data.stats);
    setUpcomingFlights(data.upcoming_flights);
    setRecentLogs(data.recent_logs);
    setSystemProblem(data.system?.problem ?? null);
    setSavings(data.savings ?? null);
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      {systemProblem && (
        <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="h-5 w-5 flex-shrink-0" />
          <div>
            <strong>{systemProblem}</strong> Check-ins won&apos;t happen until it&apos;s running again. It
            restarts by itself; if this stays for more than a few minutes, restart the Mac (or run{" "}
            <code>./macos/ctl.sh restart</code>).
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard icon={Users} label="Active Accounts" value={stats?.active_accounts ?? 0} color="blue" />
        <StatCard icon={CalendarCheck} label="Reservations" value={stats?.total_reservations ?? 0} color="purple" />
        <StatCard icon={Plane} label="Upcoming Check-ins" value={stats?.upcoming_checkins ?? 0} color="orange" />
        <StatCard icon={CheckCircle} label="Successful" value={stats?.successful_checkins ?? 0} color="green" />
        <StatCard icon={XCircle} label="Failed" value={stats?.failed_checkins ?? 0} color="red" />
      </div>

      {savings && (savings.drops_found > 0 || savings.claimed > 0) && (
        <Card>
          <CardContent className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:gap-10">
            <div>
              <div className="text-2xl font-bold text-green-700">${Math.round(savings.claimed).toLocaleString()}</div>
              <div className="text-xs text-gray-500">
                saved by rebooking ({savings.flights_claimed} flight{savings.flights_claimed === 1 ? "" : "s"})
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold text-gray-900">
                ${Math.round(savings.drops_found).toLocaleString()}
              </div>
              <div className="text-xs text-gray-500">
                in fare drops found ({savings.flights_with_drops} flight{savings.flights_with_drops === 1 ? "" : "s"})
              </div>
            </div>
            {savings.drops_found > savings.claimed && (
              <p className="text-sm text-gray-600 md:ml-auto md:max-w-sm">
                Unclaimed drops are on the Flights page with steps to claim them.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Upcoming Check-ins</CardTitle>
        </CardHeader>
        <CardContent>
          {upcomingFlights.length === 0 ? (
            <p className="text-gray-500 text-sm">No upcoming check-ins</p>
          ) : (
            <div className="space-y-3">
              {upcomingFlights.map((flight) => (
                <div
                  key={flight.id}
                  className="flex items-center justify-between rounded-lg border border-gray-100 p-4"
                >
                  <div>
                    <div className="font-medium text-sm">
                      {flight.first_name} {flight.last_name}
                    </div>
                    <div className="text-gray-500 text-xs">
                      {flight.confirmation_number} &middot; {flight.departure_airport} &rarr;{" "}
                      {flight.destination_airport}
                    </div>
                    {flight.readiness_status === "problem" && flight.readiness_detail && (
                      <div className="mt-1 text-xs text-red-700">{flight.readiness_detail}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-4">
                    <ReadinessBadge flight={flight} />
                    <StatusBadge status={flight.checkin_status} />
                    <CountdownTimer departureTime={flight.departure_time} status={flight.checkin_status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {recentLogs.length === 0 ? (
            <p className="text-gray-500 text-sm">No recent activity</p>
          ) : (
            <div className="space-y-2">
              {recentLogs.map((log) => (
                <div key={log.id} className="flex items-start gap-3 text-sm">
                  <span
                    className={`mt-0.5 h-2 w-2 rounded-full flex-shrink-0 ${
                      log.level === "error" ? "bg-red-500" : log.level === "warning" ? "bg-yellow-500" : "bg-blue-500"
                    }`}
                  />
                  <div>
                    <span className="text-gray-700">{log.message}</span>
                    <span className="ml-2 text-gray-400 text-xs">
                      {new Date(log.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Result of the safety net's last pre-check-in check (worker/safety_net.py),
// which runs in the 3 hours before each check-in.
function ReadinessBadge({ flight }: { flight: Flight }) {
  if (!flight.readiness_status) return null;
  const checked = flight.readiness_checked_at
    ? new Date(flight.readiness_checked_at.replace(" ", "T") + "Z").toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  if (flight.readiness_status === "ready") {
    return (
      <span
        className="flex items-center gap-1 text-xs text-green-700"
        title={`${flight.readiness_detail ?? ""} Checked ${checked}.`}
      >
        <ShieldCheck className="h-3.5 w-3.5" /> Ready
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700"
      title={`${flight.readiness_detail ?? ""} Checked ${checked}.`}
    >
      <AlertTriangle className="h-3.5 w-3.5" /> At risk
    </span>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    blue: "text-blue-600 bg-blue-50",
    purple: "text-purple-600 bg-purple-50",
    orange: "text-orange-600 bg-orange-50",
    green: "text-green-600 bg-green-50",
    red: "text-red-600 bg-red-50",
  };
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={`rounded-lg p-2 ${colorMap[color]}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-2xl font-bold">{value}</p>
            <p className="text-xs text-gray-500">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
