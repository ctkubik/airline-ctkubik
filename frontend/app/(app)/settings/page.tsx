"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, Plus, Save, MessageSquare, Sparkles, RefreshCw } from "lucide-react";
import type { NotificationConfig } from "@/lib/types";

const ALL_SEAT_LETTERS = ["A", "B", "C", "D", "E", "F"];

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
  const [preferredLetters, setPreferredLetters] = useState<string[]>(["A", "F"]);
  const [preferredRows, setPreferredRows] = useState("1,2,3,4,5,6");
  const [fallbackLetters, setFallbackLetters] = useState<string[]>(["A", "C", "D", "F"]);
  const [fareCheckMode, setFareCheckMode] = useState("same_day_nonstop");
  const [seatSaved, setSeatSaved] = useState(false);

  // Local LLM (LM Studio) connection status
  const [llm, setLlm] = useState<{
    enabled: boolean;
    baseUrl: string;
    reachable: boolean;
    model: string | null;
    error?: string;
  } | null>(null);
  const [llmChecking, setLlmChecking] = useState(false);

  useEffect(() => {
    fetchNotifications();
    fetchPreferences();
    fetchLlmStatus();
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  async function fetchLlmStatus() {
    setLlmChecking(true);
    try {
      const res = await fetch("/api/llm/status");
      setLlm(res.ok ? await res.json() : null);
    } catch {
      setLlm(null);
    }
    setLlmChecking(false);
  }

  async function fetchNotifications() {
    const res = await fetch("/api/notifications");
    setNotifications(await res.json());
  }

  async function fetchPreferences() {
    const res = await fetch("/api/preferences");
    const data = await res.json();
    if (data.preferred_letters) setPreferredLetters(data.preferred_letters.split(","));
    if (data.preferred_rows) setPreferredRows(data.preferred_rows);
    if (data.fallback_letters) setFallbackLetters(data.fallback_letters.split(","));
    if (data.fare_check_mode) setFareCheckMode(data.fare_check_mode);
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

  async function savePreferences() {
    setSeatSaved(false);
    await fetch("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preferred_letters: preferredLetters.join(","),
        preferred_rows: preferredRows,
        fallback_letters: fallbackLetters.join(","),
        fare_check_mode: fareCheckMode,
      }),
    });
    setSeatSaved(true);
    setTimeout(() => setSeatSaved(false), 2000);
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

  function toggleLetter(letter: string, list: string[], setList: (v: string[]) => void) {
    if (list.includes(letter)) {
      setList(list.filter((l) => l !== letter));
    } else {
      setList([...list, letter].sort());
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {/* Seat Preferences */}
      <Card>
        <CardHeader>
          <CardTitle>Seat Preferences</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-500">
            Configure your preferred seat selections. Southwest now assigns seats at booking or
            check-in. For Basic fares, a seat is assigned at check-in. For A-List members, the app
            will attempt to upgrade to a preferred seat 48 hours before departure. These preferences
            determine which seats the system will target.
          </p>

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

          <Button onClick={savePreferences}>
            <Save className="mr-2 h-4 w-4" />
            {seatSaved ? "Saved!" : "Save Preferences"}
          </Button>
        </CardContent>
      </Card>

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

      {/* Local AI */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" /> Local AI (LM Studio)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-gray-600">
            An optional model running on this machine. It explains errors on the Diagnostics tab, fills in
            fare watches from a sentence, and helps the seat-upgrade automation when Southwest changes its
            website. Check-ins never depend on it.
          </p>
          {llm === null ? (
            <p className="text-gray-500">Checking...</p>
          ) : !llm.enabled ? (
            <p className="text-gray-700">
              <span className="font-medium">Off.</span> To turn it on, set <code>LLM_ENABLED=true</code> in{" "}
              <code>.env</code>, start LM Studio&apos;s local server with a model loaded, and restart the app.
            </p>
          ) : llm.reachable && llm.model ? (
            <p className="text-green-700">
              <span className="font-medium">Connected</span> to {llm.baseUrl} using <code>{llm.model}</code>.
            </p>
          ) : (
            <p className="text-red-700">
              <span className="font-medium">Not reachable</span> at {llm.baseUrl}
              {llm.error ? `: ${llm.error}` : ""}. Open LM Studio, load a model, and start the server
              (Developer tab).
            </p>
          )}
          <Button variant="outline" size="sm" onClick={fetchLlmStatus} disabled={llmChecking}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${llmChecking ? "animate-spin" : ""}`} /> Check again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
