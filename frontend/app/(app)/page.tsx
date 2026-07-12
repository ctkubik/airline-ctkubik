"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/flights/status-badge";
import { CountdownTimer } from "@/components/flights/countdown-timer";
import { Users, CalendarCheck, Plane, CheckCircle2, XCircle, ArrowRight } from "lucide-react";
import type { DashboardStats, Flight, WorkerLog } from "@/lib/types";

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [upcomingFlights, setUpcomingFlights] = useState<Flight[]>([]);
  const [recentLogs, setRecentLogs] = useState<WorkerLog[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

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
    setIsAdmin(!!data.is_admin);
  }

  return (
    <div className="space-y-7">
      <header>
        <div className="eyebrow mb-1">Overview</div>
        <h1 className="text-[28px] font-semibold tracking-tight">Dashboard</h1>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile icon={Users} label="Accounts" value={stats?.active_accounts ?? 0} tone="brand" />
        <StatTile icon={CalendarCheck} label="Reservations" value={stats?.total_reservations ?? 0} tone="brand" />
        <StatTile icon={Plane} label="Upcoming" value={stats?.upcoming_checkins ?? 0} tone="accent" />
        <StatTile icon={CheckCircle2} label="Checked in" value={stats?.successful_checkins ?? 0} tone="success" />
        <StatTile icon={XCircle} label="Failed" value={stats?.failed_checkins ?? 0} tone="danger" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upcoming Check-ins</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {upcomingFlights.length === 0 ? (
            <EmptyRow text="No upcoming check-ins. Add a Southwest account or reservation to get started." />
          ) : (
            <ul className="divide-y divide-[color:var(--line)]">
              {upcomingFlights.map((flight) => (
                <li key={flight.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <div className="flex min-w-[190px] items-center gap-2.5 font-mono text-[15px] font-semibold tracking-tight">
                    <span>{flight.departure_airport}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-[color:var(--accent)]" />
                    <span>{flight.destination_airport}</span>
                  </div>
                  <div className="text-[13px] text-[color:var(--muted)]">
                    {flight.first_name} {flight.last_name}
                    <span className="mx-1.5 text-[color:var(--line-strong)]">·</span>
                    <span className="font-mono">{flight.confirmation_number}</span>
                  </div>
                  <div className="ml-auto flex items-center gap-4">
                    <StatusBadge status={flight.checkin_status} />
                    <CountdownTimer departureTime={flight.departure_time} status={flight.checkin_status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {recentLogs.length === 0 ? (
              <p className="text-sm text-[color:var(--muted)]">No recent activity</p>
            ) : (
              <ul className="space-y-3">
                {recentLogs.map((log) => (
                  <li key={log.id} className="flex items-start gap-3 text-[13px]">
                    <span
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          log.level === "error"
                            ? "var(--danger)"
                            : log.level === "warning"
                            ? "var(--warning)"
                            : "var(--success)",
                      }}
                    />
                    <span className="text-[color:var(--ink-soft)]">{log.message}</span>
                    <span className="ml-auto shrink-0 whitespace-nowrap font-mono text-[11px] text-[color:var(--faint)]">
                      {new Date(log.created_at).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="px-5 py-8 text-center text-sm text-[color:var(--muted)]">{text}</p>;
}

const toneStyles: Record<string, { fg: string; bg: string }> = {
  brand: { fg: "var(--brand)", bg: "var(--brand-tint)" },
  accent: { fg: "var(--accent)", bg: "var(--accent-tint)" },
  success: { fg: "var(--success)", bg: "var(--success-tint)" },
  danger: { fg: "var(--danger)", bg: "var(--danger-tint)" },
};

function StatTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  tone: keyof typeof toneStyles;
}) {
  const t = toneStyles[tone];
  return (
    <div className="ticket ticket-hover p-4">
      <div
        className="mb-3 flex h-8 w-8 items-center justify-center rounded-[9px]"
        style={{ color: t.fg, backgroundColor: t.bg }}
      >
        <Icon className="h-[17px] w-[17px]" />
      </div>
      <div className="font-mono text-[26px] font-semibold leading-none tracking-tight tabular">{value}</div>
      <div className="eyebrow mt-1.5">{label}</div>
    </div>
  );
}
