"use client";

import Link from "next/link";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, Plus, MessageSquare, CalendarDays } from "lucide-react";
import type { NotificationConfig } from "@/lib/types";
import { SeatPreferencesForm } from "@/components/seat-preferences-form";
import { TelegramSetup } from "@/components/telegram-setup";


// Matches worker/notifications.py: which alerts a service receives
const LEVELS = [
  { value: 1, label: "Everything" },
  { value: 2, label: "Important only" },
  { value: 3, label: "Problems only" },
];
const LEVEL_HELP =
  "Everything: check-ins, seat changes, fare drops and problems. Important only: everything except routine successful check-ins. Problems only: failed or missed check-ins, safety-net warnings, and the app being down.";

interface AccountOption {
  id: string;
  display_name: string;
  username: string;
}

function accountName(a: AccountOption): string {
  return a.display_name || a.username;
}

// account_ids is a JSON list; the UI picks one person or everyone
function whoValue(accountIds?: string | null): string {
  try {
    const ids = JSON.parse(accountIds || "null");
    return Array.isArray(ids) && ids.length ? ids[0] : "";
  } catch {
    return "";
  }
}

export default function SettingsPage() {
  const [notifications, setNotifications] = useState<NotificationConfig[]>([]);
  const [serviceUrl, setServiceUrl] = useState("");
  const [notificationLevel, setNotificationLevel] = useState(1);
  const [serviceLabel, setServiceLabel] = useState("");
  const [serviceWho, setServiceWho] = useState("");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Twilio SMS quick setup
  const [twilioSid, setTwilioSid] = useState("");
  const [twilioToken, setTwilioToken] = useState("");
  const [twilioFrom, setTwilioFrom] = useState("");
  const [twilioTo, setTwilioTo] = useState("");
  const [smsLoading, setSmsLoading] = useState(false);

  // Seat preferences

  // Local LLM (LM Studio) connection status

  // Calendar feed subscription link
  const [calendarToken, setCalendarToken] = useState<string | null>(null);
  const [calendarCopied, setCalendarCopied] = useState(false);
  const calendarUrl =
    calendarToken && typeof window !== "undefined"
      ? `${window.location.origin}/api/calendar/feed?token=${calendarToken}`
      : "";

  useEffect(() => {
    fetchNotifications();
    fetch("/api/calendar/link")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCalendarToken(d?.token ?? null))
      .catch(() => setCalendarToken(null));
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  async function fetchNotifications() {
    const res = await fetch("/api/notifications");
    setNotifications(await res.json());
  }



  async function addNotification(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_url: serviceUrl,
        notification_level: notificationLevel,
        label: serviceLabel,
        account_ids: serviceWho ? [serviceWho] : null,
      }),
    });
    setServiceUrl("");
    setServiceLabel("");
    setServiceWho("");
    setNotificationLevel(1);
    setLoading(false);
    fetchNotifications();
  }

  async function updateNotification(id: string, patch: Record<string, unknown>) {
    await fetch(`/api/notifications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    fetchNotifications();
  }

  async function deleteNotification(id: string) {
    await fetch(`/api/notifications/${id}`, { method: "DELETE" });
    fetchNotifications();
  }

  async function testNotifications() {
    setTestResult(null);
    const res = await fetch("/api/notifications/test", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      setTestResult(data.message);
    } else {
      setTestResult(data.error || "Test failed");
    }
    setTimeout(() => setTestResult(null), 5000);
  }


  async function addTwilioSms(e: React.FormEvent) {
    e.preventDefault();
    if (!twilioSid || !twilioToken || !twilioFrom || !twilioTo) return;
    setSmsLoading(true);
    const fromClean = twilioFrom.replace(/\D/g, "");
    const toClean = twilioTo.replace(/\D/g, "");
    const url = `twilio://${twilioSid}:${twilioToken}@+${fromClean}/+${toClean}`;
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_url: url,
        notification_level: 1,
        label: `Text to ${twilioTo}`,
      }),
    });
    setTwilioSid("");
    setTwilioToken("");
    setTwilioFrom("");
    setTwilioTo("");
    setSmsLoading(false);
    fetchNotifications();
  }


  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {/* Seat Preferences (shared; accounts can have their own) */}
      <SeatPreferencesForm />

      {/* Telegram (guided setup) */}
      <TelegramSetup onSaved={fetchNotifications} />

      {/* SMS Text Notifications */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" /> SMS Text Notifications
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-500">
            Get text message alerts for check-ins, fare drops, and status updates.
            Requires a Twilio account (free trial available).
          </p>
          <form onSubmit={addTwilioSms} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Twilio Account SID
                </label>
                <Input
                  value={twilioSid}
                  onChange={(e) => setTwilioSid(e.target.value)}
                  placeholder="ACxxxxxxxxxx"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Twilio Auth Token
                </label>
                <Input
                  type="password"
                  value={twilioToken}
                  onChange={(e) => setTwilioToken(e.target.value)}
                  placeholder="Auth token"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  From Phone Number
                </label>
                <Input
                  value={twilioFrom}
                  onChange={(e) => setTwilioFrom(e.target.value)}
                  placeholder="+1234567890"
                  required
                />
                <p className="text-xs text-gray-400 mt-0.5">Your Twilio phone number</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  To Phone Number
                </label>
                <Input
                  value={twilioTo}
                  onChange={(e) => setTwilioTo(e.target.value)}
                  placeholder="+1234567890"
                  required
                />
                <p className="text-xs text-gray-400 mt-0.5">Your mobile number</p>
              </div>
            </div>
            <Button type="submit" disabled={smsLoading}>
              <MessageSquare className="mr-2 h-4 w-4" />
              {smsLoading ? "Adding..." : "Add SMS Notification"}
            </Button>
          </form>
          <p className="text-xs text-gray-400">
            You can also use other SMS providers via Apprise URLs in the section below.
          </p>
        </CardContent>
      </Card>

      {/* Notifications */}
      <Card>
        <CardHeader>
          <CardTitle>Notification Services</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-500">
            Add notification URLs using{" "}
            <a
              href="https://github.com/caronc/apprise#supported-notifications"
              className="text-blue-600 underline"
              target="_blank"
              rel="noreferrer"
            >
              Apprise URL format
            </a>
            . Examples: <code className="bg-gray-100 px-1 rounded text-xs">tgram://bottoken/ChatID</code>,{" "}
            <code className="bg-gray-100 px-1 rounded text-xs">discord://WebhookID/WebhookToken</code>
          </p>

          <form onSubmit={addNotification} className="space-y-2">
            <div className="flex flex-col gap-2 md:flex-row">
              <Input
                value={serviceUrl}
                onChange={(e) => setServiceUrl(e.target.value)}
                placeholder="Apprise notification URL"
                className="flex-1"
                required
              />
              <Input
                value={serviceLabel}
                onChange={(e) => setServiceLabel(e.target.value)}
                placeholder="Name, e.g. Mom's phone"
                className="md:w-48"
              />
            </div>
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <select
                value={serviceWho}
                onChange={(e) => setServiceWho(e.target.value)}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                aria-label="Whose alerts"
              >
                <option value="">Alerts for everyone&apos;s trips</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    Only {accountName(a)}&apos;s trips
                  </option>
                ))}
              </select>
              <select
                value={notificationLevel}
                onChange={(e) => setNotificationLevel(Number(e.target.value))}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                aria-label="Which alerts"
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              <Button type="submit" disabled={loading}>
                <Plus className="mr-1 h-4 w-4" /> Add
              </Button>
            </div>
            <p className="text-xs text-gray-400">
              {LEVEL_HELP} Warnings that the app itself is down always go to every service.
            </p>
          </form>

          {notifications.length > 0 && (
            <>
              <div className="space-y-2">
                {notifications.map((n) => (
                  <div
                    key={n.id}
                    className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3 md:flex-row md:items-center md:justify-between"
                  >
                    <div className="min-w-0">
                      <Input
                        defaultValue={n.label || ""}
                        placeholder="Add a name"
                        className="h-8 w-48 text-sm"
                        onBlur={(e) => {
                          if (e.target.value !== (n.label || "")) updateNotification(n.id, { label: e.target.value });
                        }}
                      />
                      <code className="mt-1 block text-xs text-gray-400">{n.service_url}</code>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={whoValue(n.account_ids)}
                        onChange={(e) =>
                          updateNotification(n.id, { account_ids: e.target.value ? [e.target.value] : null })
                        }
                        className="rounded-md border border-gray-300 px-2 py-1 text-xs"
                        aria-label="Whose alerts"
                      >
                        <option value="">Everyone&apos;s trips</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            Only {accountName(a)}
                          </option>
                        ))}
                      </select>
                      <select
                        value={Math.min(Math.max(n.notification_level, 1), 3)}
                        onChange={(e) => updateNotification(n.id, { notification_level: Number(e.target.value) })}
                        className="rounded-md border border-gray-300 px-2 py-1 text-xs"
                        aria-label="Which alerts"
                      >
                        {LEVELS.map((l) => (
                          <option key={l.value} value={l.value}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                      <Button variant="ghost" size="icon" onClick={() => deleteNotification(n.id)}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={testNotifications}>
                  Send Test Notification
                </Button>
                {testResult && (
                  <span className="text-sm text-green-600">{testResult}</span>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Calendar feed */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5" /> Calendar
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-gray-600">
            Subscribe to this private link in Apple Calendar, Google Calendar or Outlook to see every upcoming
            flight and when its check-in opens, with the seat added after check-in. It updates every hour. The
            device needs to reach this app (same Wi-Fi, Tailscale, or your public URL).
          </p>
          {calendarUrl ? (
            <>
              <code className="block break-all rounded bg-gray-50 px-2 py-1 text-xs text-gray-700">{calendarUrl}</code>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => (window.location.href = calendarUrl.replace(/^https?:/, "webcal:"))}>
                  Add to Calendar
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(calendarUrl);
                    setCalendarCopied(true);
                    setTimeout(() => setCalendarCopied(false), 2000);
                  }}
                >
                  {calendarCopied ? "Copied" : "Copy link"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    if (!window.confirm("Make a new link? Calendars using the old link will stop updating.")) return;
                    const r = await fetch("/api/calendar/link", { method: "POST" });
                    const d = await r.json();
                    setCalendarToken(d.token);
                  }}
                >
                  New link
                </Button>
              </div>
              <p className="text-xs text-gray-400">
                Anyone with this link can see your flights. Use New link to cut off an old one.
              </p>
            </>
          ) : (
            <p className="text-gray-500">Loading...</p>
          )}
        </CardContent>
      </Card>

      {/* API keys and LM Studio live on their own page */}
      <Card>
        <CardHeader>
          <CardTitle>API Connections</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600">
          <span>
            Local AI (LM Studio), flight status alerts and Google Flights prices are set up on the API Connections page,
            with step-by-step instructions and a test button for each.
          </span>
          <Link href="/connections">
            <Button variant="outline">Open API Connections</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
