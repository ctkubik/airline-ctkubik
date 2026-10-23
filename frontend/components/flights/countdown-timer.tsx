"use client";

import { useEffect, useState } from "react";

// Check-in opens checkinHours before departure: 24, or 48 for A-List
function getTimeUntil(targetDate: string, checkinHours = 24): string {
  const now = new Date();
  const checkinTime = new Date(new Date(targetDate).getTime() - checkinHours * 60 * 60 * 1000);
  const diff = checkinTime.getTime() - now.getTime();

  if (diff <= 0) return "Now";

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function CountdownTimer({
  departureTime,
  status,
  checkinHours,
}: {
  departureTime: string;
  status: string;
  checkinHours?: number | null;
}) {
  const hours = checkinHours || 24;
  const [timeLeft, setTimeLeft] = useState(getTimeUntil(departureTime, hours));

  useEffect(() => {
    if (status === "success" || status === "failed") return;
    const interval = setInterval(() => setTimeLeft(getTimeUntil(departureTime, hours)), 1000);
    return () => clearInterval(interval);
  }, [departureTime, status, hours]);

  if (status === "success") return <span className="text-green-600 text-sm">Checked in</span>;
  if (status === "failed") return <span className="text-red-600 text-sm">Failed</span>;

  return <span className="text-sm font-mono text-blue-600">{timeLeft}</span>;
}
