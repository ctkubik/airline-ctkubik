"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, ExternalLink, Send, XCircle } from "lucide-react";

interface Chat {
  id: string;
  name: string;
  type: string;
}

interface AccountOption {
  id: string;
  display_name: string;
  username: string;
}

interface Result {
  ok: boolean;
  message: string;
}

const LEVELS = [
  { value: 1, label: "Everything" },
  { value: 2, label: "Important only" },
  { value: 3, label: "Problems only" },
];

function StepTitle({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 font-medium text-gray-900">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-600 text-xs font-bold text-white">
        {n}
      </span>
      {children}
    </div>
  );
}

function Message({ result }: { result: Result | null }) {
  if (!result) return null;
  return (
    <div
      className={`flex items-start gap-2 rounded-md p-3 text-sm ${
        result.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"
      }`}
    >
      {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{result.message}</span>
    </div>
  );
}

// Step-by-step Telegram setup: make a bot with BotFather, message it, let the
// app find the chat, send a test, and save it as an alert service.
export function TelegramSetup({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [bot, setBot] = useState<{ name: string; link: string | null } | null>(null);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [chatId, setChatId] = useState("");
  const [label, setLabel] = useState("");
  const [level, setLevel] = useState(1);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [audience, setAudience] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [findResult, setFindResult] = useState<Result | null>(null);
  const [testResult, setTestResult] = useState<Result | null>(null);
  const [saveResult, setSaveResult] = useState<Result | null>(null);

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  async function call(action: string, extra: Record<string, unknown> = {}) {
    const res = await fetch("/api/notifications/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, token: token.trim(), ...extra }),
    });
    return res.json().catch(() => ({ ok: false, message: "No answer from the app" }));
  }

  async function findChats() {
    setBusy("find");
    setFindResult(null);
    const body = await call("chats");
    setBusy(null);
    if (!body.ok) {
      setFindResult(body);
      return;
    }
    setBot({ name: body.bot, link: body.bot_link });
    setChats(body.chats);
    if (body.chats.length === 1) {
      setChatId(body.chats[0].id);
      if (!label) setLabel(`${body.chats[0].name} (Telegram)`);
    }
    setFindResult(
      body.chats.length
        ? { ok: true, message: `Connected to ${body.bot}. Found ${body.chats.length} chat${body.chats.length > 1 ? "s" : ""}.` }
        : {
            ok: false,
            message: `Connected to ${body.bot}, but nobody has messaged it yet. Do step 2, then click Find my chat again.`,
          }
    );
  }

  async function test() {
    setBusy("test");
    setTestResult(await call("test", { chat_id: chatId }));
    setBusy(null);
  }

  async function save() {
    setBusy("save");
    const body = await call("save", {
      chat_id: chatId,
      label: label || "Telegram",
      notification_level: level,
      account_ids: audience ? [audience] : [],
    });
    setBusy(null);
    setSaveResult(body);
    if (body.ok) {
      setToken("");
      setChats(null);
      setChatId("");
      setLabel("");
      setBot(null);
      setFindResult(null);
      setTestResult(null);
      onSaved();
    }
  }

  const chosen = chats?.find((c) => c.id === chatId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="h-5 w-5 text-sky-600" /> Telegram Alerts
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <p className="text-gray-600">
          Free, instant alerts on your phone, computer and watch through the Telegram app. You make your own private
          bot (about 5 minutes), and the app sends your check-in, seat, fare and flight status alerts through it.
          Nobody else can read them.
        </p>

        {/* Step 1 */}
        <div className="space-y-2">
          <StepTitle n={1}>Create your bot with BotFather</StepTitle>
          <ol className="list-decimal space-y-1 pl-12 text-gray-700">
            <li>
              Install Telegram on your phone (
              <a className="text-sky-700 underline" href="https://telegram.org/apps" target="_blank" rel="noreferrer">
                telegram.org/apps
              </a>
              ) and sign in with your phone number.
            </li>
            <li>
              Open a chat with{" "}
              <a className="inline-flex items-center gap-0.5 text-sky-700 underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                @BotFather <ExternalLink className="h-3 w-3" />
              </a>
              . It&apos;s Telegram&apos;s official bot maker and has a blue check mark. Tap <b>Start</b>.
            </li>
            <li>
              Send <code className="rounded bg-gray-100 px-1">/newbot</code>.
            </li>
            <li>
              When it asks for a name, send anything, like <b>Flight Alerts</b>.
            </li>
            <li>
              When it asks for a username, send one that ends in <b>bot</b> and isn&apos;t taken, like{" "}
              <b>kubik_flights_bot</b>.
            </li>
            <li>
              BotFather replies with a <b>token</b> that looks like <code className="rounded bg-gray-100 px-1">123456789:AAH4k...</code>.
              Copy the whole thing and paste it below. Treat it like a password.
            </li>
          </ol>
          <div className="pl-8">
            <Input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste the bot token from BotFather"
            />
          </div>
        </div>

        {/* Step 2 */}
        <div className="space-y-2">
          <StepTitle n={2}>Say hello to your bot</StepTitle>
          <ul className="list-disc space-y-1 pl-12 text-gray-700">
            <li>
              <b>Just you:</b> tap the link BotFather sent (t.me/your_bot_name){bot?.link && (
                <>
                  {" "}or{" "}
                  <a className="text-sky-700 underline" href={bot.link} target="_blank" rel="noreferrer">
                    open {bot.name}
                  </a>
                </>
              )}
              , tap <b>Start</b>, then send any message, like <i>hi</i>.
            </li>
            <li>
              <b>The whole family in one place:</b> create a Telegram group, add your bot as a member, then send a message
              in the group that mentions it, like <code className="rounded bg-gray-100 px-1">/start@kubik_flights_bot</code>.
            </li>
            <li>
              <b>Separate alerts per person:</b> each person opens the bot and taps Start on their own phone. Then add one
              Telegram service per person below and choose whose trips each one gets.
            </li>
          </ul>
        </div>

        {/* Step 3 */}
        <div className="space-y-2">
          <StepTitle n={3}>Find the chat</StepTitle>
          <p className="pl-8 text-gray-700">
            The app asks Telegram which chats have messaged your bot. If nothing shows, send the bot another message and
            try again (Telegram only keeps the last day of messages).
          </p>
          <div className="space-y-2 pl-8">
            <Button variant="outline" onClick={findChats} disabled={!token.trim() || busy !== null}>
              {busy === "find" ? "Looking..." : "Find my chat"}
            </Button>
            <Message result={findResult} />
            {chats && chats.length > 0 && (
              <div className="space-y-1">
                {chats.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 rounded-md border border-gray-200 p-2">
                    <input
                      type="radio"
                      name="telegram-chat"
                      checked={chatId === c.id}
                      onChange={() => {
                        setChatId(c.id);
                        setLabel(`${c.name} (Telegram)`);
                      }}
                    />
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-gray-500">{c.type}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Step 4 */}
        <div className="space-y-2">
          <StepTitle n={4}>Test and save</StepTitle>
          <div className="grid gap-3 pl-8 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Chad's Telegram" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Whose trips</label>
              <select
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                className="h-10 w-full rounded-md border border-gray-300 px-2 text-sm"
              >
                <option value="">Everyone&apos;s</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name || a.username}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Which alerts</label>
              <select
                value={level}
                onChange={(e) => setLevel(Number(e.target.value))}
                className="h-10 w-full rounded-md border border-gray-300 px-2 text-sm"
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pl-8">
            <Button variant="outline" onClick={test} disabled={!chatId || busy !== null}>
              {busy === "test" ? "Sending..." : "Send test message"}
            </Button>
            <Button onClick={save} disabled={!chatId || busy !== null}>
              {busy === "save" ? "Saving..." : `Save${chosen ? ` (${chosen.name})` : ""}`}
            </Button>
          </div>
          <div className="space-y-2 pl-8">
            <Message result={testResult} />
            <Message result={saveResult} />
          </div>
        </div>

        <details className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-gray-700">
          <summary className="cursor-pointer font-medium text-gray-900">Troubleshooting</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <b>&quot;Didn&apos;t recognize that bot token&quot;:</b> copy the token again from BotFather. You can also send
              BotFather <code>/mybots</code>, pick your bot, then <b>API Token</b>.
            </li>
            <li>
              <b>No chats found:</b> open your bot and send it a new message, then click Find my chat within a few minutes.
            </li>
            <li>
              <b>Group not listed:</b> group bots only see messages addressed to them. Send{" "}
              <code>/start@your_bot_name</code> in the group.
            </li>
            <li>
              <b>Alerts stopped:</b> you may have muted or blocked the bot. Open it in Telegram and tap Unblock or Unmute.
              Click Send Test Notification further down this page to check.
            </li>
            <li>
              <b>Token leaked or shared by mistake:</b> send BotFather <code>/revoke</code>, pick the bot, delete the old
              Telegram service below, and set it up again with the new token.
            </li>
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}
