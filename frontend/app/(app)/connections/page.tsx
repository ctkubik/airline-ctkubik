"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, ExternalLink, Globe, PlugZap, Sparkles, XCircle } from "lucide-react";

type Source = "app" | "env" | "default";

interface Setting {
  value: string;
  source: Source;
  secret: boolean;
  default: string;
}

interface Payload {
  settings: Record<string, Setting>;
  can_edit: boolean;
  docker: boolean;
}

interface Usage {
  flight_status: { used: number; limit: number };
  google_flights: { used: number; limit: number };
}

interface TestResult {
  ok: boolean;
  message: string;
  models?: string[];
}

const SOURCE_LABEL: Record<Source, string> = {
  app: "saved here",
  env: "from .env file",
  default: "default",
};

function Field({
  label,
  hint,
  source,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  source?: Source;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="text-sm font-medium text-gray-700">{label}</label>
        {source && <span className="text-xs text-gray-400">{SOURCE_LABEL[source]}</span>}
      </div>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

function Steps({ children }: { children: React.ReactNode }) {
  return (
    <details className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700" open>
      <summary className="cursor-pointer font-medium text-gray-900">How to set it up</summary>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5">{children}</ol>
    </details>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-blue-600 underline">
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function Result({ result }: { result: TestResult | null }) {
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

export default function ConnectionsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [tests, setTests] = useState<Record<string, TestResult | null>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);

  const load = useCallback(async () => {
    const [c, u] = await Promise.all([fetch("/api/connections"), fetch("/api/services/status")]);
    if (c.ok) {
      const body = (await c.json()) as Payload;
      setData(body);
      setForm(Object.fromEntries(Object.entries(body.settings).map(([k, v]) => [k, v.value])));
    }
    if (u.ok) setUsage(await u.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = (name: string, value: string) => setForm((f) => ({ ...f, [name]: value }));

  async function save(section: string, names: string[]) {
    setSaving(section);
    setError("");
    const res = await fetch("/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: Object.fromEntries(names.map((n) => [n, form[n] ?? ""])) }),
    });
    const body = await res.json().catch(() => null);
    setSaving(null);
    if (!res.ok) {
      setError(body?.error || "Couldn't save");
      return;
    }
    setSaved(section);
    setTimeout(() => setSaved(null), 2500);
    await load();
  }

  async function removeKey(name: string) {
    if (!window.confirm("Remove this key? The feature turns off unless the .env file has one.")) return;
    await fetch("/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remove: [name] }),
    });
    await load();
  }

  async function test(service: "lmstudio" | "aerodatabox" | "serpapi") {
    setTesting(service);
    setTests((t) => ({ ...t, [service]: null }));
    const body =
      service === "lmstudio"
        ? { service, base_url: form.LLM_BASE_URL, model: form.LLM_MODEL, key: form.LLM_API_KEY }
        : { service, key: form[service === "aerodatabox" ? "AERODATABOX_API_KEY" : "SERPAPI_API_KEY"] };
    const res = await fetch("/api/connections/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await res.json().catch(() => ({ ok: false, message: "No answer from the app" }))) as TestResult;
    setTesting(null);
    setTests((t) => ({ ...t, [service]: result }));
    if (result.models) setModels(result.models);
  }

  if (!data) return <div className="text-sm text-gray-500">Loading...</div>;
  const s = data.settings;
  const editable = data.can_edit;
  const keyField = (name: string, placeholder: string) => (
    <div className="flex gap-2">
      <Input
        type="password"
        autoComplete="off"
        value={form[name] ?? ""}
        onFocus={() => form[name]?.startsWith("••••") && set(name, "")}
        onBlur={() => !form[name] && set(name, s[name].value)}
        onChange={(e) => set(name, e.target.value)}
        placeholder={placeholder}
        disabled={!editable}
      />
      {s[name].source === "app" && editable && (
        <Button type="button" variant="outline" onClick={() => removeKey(name)}>
          Remove
        </Button>
      )}
    </div>
  );
  const status = (on: boolean, used?: { used: number; limit: number } | null, unit?: string) =>
    on ? (
      <Badge variant="success">
        Connected{used ? ` · ${used.used} of ${used.limit} ${unit} this month` : ""}
      </Badge>
    ) : (
      <Badge variant="inactive">Not set up</Badge>
    );
  const llmOn = form.LLM_ENABLED === "true";
  const modelOptions = Array.from(new Set([...(form.LLM_MODEL ? [form.LLM_MODEL] : []), ...models]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
          <PlugZap className="h-6 w-6 text-blue-600" /> API Connections
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-500">
          How the app reaches Southwest, and the outside services it can use. The outside services are optional; each one turns on extra features. Keys are
          stored encrypted on this computer, and changes apply within a minute with no restart. A value saved here
          takes the place of the same setting in the .env file.
        </p>
      </div>

      {!editable && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
          You can view these settings. Ask an admin to change them.
        </p>
      )}
      {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {/* How the app talks to Southwest */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-blue-600" /> Southwest connection
            </CardTitle>
            <Badge variant="success">
              {form.SOUTHWEST_PHONE_APP === "true" ? "Website + phone-app service" : "Website only"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-gray-600">
          <p>
            The app works through southwest.com in its own Chrome window, the same way you would: it checks in,
            looks up reservations, reads your trips and picks seats on the website.
          </p>
          <label className="flex items-start gap-2 text-gray-800">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.SOUTHWEST_PHONE_APP === "true"}
              disabled={!editable}
              onChange={(e) => set("SOUTHWEST_PHONE_APP", e.target.checked ? "true" : "false")}
            />
            <span>
              Also use Southwest&apos;s phone-app service (optional)
              <span className="block text-xs text-gray-500">
                Adds fare-drop checks on flights you&apos;ve booked and a faster check-in, with the website as backup.
                Leave it off if you see mobile-site errors like &quot;Error 404040404&quot;.
              </span>
            </span>
          </label>
          {editable && (
            <div className="flex justify-end">
              <Button onClick={() => save("southwest", ["SOUTHWEST_PHONE_APP"])} disabled={saving !== null}>
                {saving === "southwest" ? "Saving..." : saved === "southwest" ? "Saved" : "Save"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* LM Studio */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-purple-600" /> Local AI (LM Studio)
            </CardTitle>
            {status(s.LLM_ENABLED.value === "true")}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600">
            Runs on your own Mac, free, and nothing leaves the computer. It reads confirmation emails, explains errors in
            plain English, turns a sentence into a fare watch, reads Southwest&apos;s seat map and confirms seat changes,
            and helps sign in to airline accounts. Check-ins never depend on it.
          </p>
          <Steps>
            <li>
              Download <Ext href="https://lmstudio.ai">LM Studio</Ext> and install it on the Mac Mini.
            </li>
            <li>
              In LM Studio, open <b>Discover</b> (the magnifying glass) and download an instruction model. Good fits for a
              Mac Mini: <b>Qwen3 8B</b>, <b>Llama 3.1 8B Instruct</b> or <b>Gemma 3 12B</b>. Pick a 4-bit (Q4) version on a
              16 GB Mac.
            </li>
            <li>
              Press <b>Cmd+L</b> (or click <b>Select a model to load</b> at the top), pick the model, set its{" "}
              <b>Context Length to 16384 or more</b> (seat maps are long), and click <b>Load</b>. In the Developer
              tab&apos;s server settings, turn on <b>Just-in-Time model loading</b> so the model comes back by itself
              after LM Studio or the Mac restarts.
            </li>
            <li>
              Open the <b>Developer</b> tab and switch the server on (Status: Running, port 1234). In LM Studio&apos;s
              settings, turn on starting the server when LM Studio opens, and add LM Studio to System Settings &gt; General
              &gt; Login Items so it comes back after a restart.
            </li>
            <li>
              If <b>Require Authentication</b> is on in the Developer tab&apos;s server settings, either turn it off (the
              server only listens on this Mac) or click <b>Manage Tokens</b>, create a token, and paste it in{" "}
              <b>API token</b> below. A test that says &quot;asking for an API token&quot; (error 401) means this step.
            </li>
            <li>
              Back here, click <b>Test connection</b>, pick the model, turn on <b>Use local AI</b>, and save.
            </li>
          </Steps>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={llmOn}
              disabled={!editable}
              onChange={(e) => set("LLM_ENABLED", e.target.checked ? "true" : "false")}
            />
            Use local AI
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Server address"
              source={s.LLM_BASE_URL.source}
              hint={
                data.docker
                  ? "Running in Docker: use http://host.docker.internal:1234/v1 to reach LM Studio on the same computer."
                  : "LM Studio's default is http://localhost:1234/v1. For LM Studio on another computer, use its address."
              }
            >
              <Input
                value={form.LLM_BASE_URL ?? ""}
                onChange={(e) => set("LLM_BASE_URL", e.target.value)}
                placeholder={s.LLM_BASE_URL.default}
                disabled={!editable}
              />
            </Field>
            <Field label="Model" source={s.LLM_MODEL.source} hint="Test connection lists the models loaded in LM Studio.">
              <select
                value={form.LLM_MODEL ?? ""}
                onChange={(e) => set("LLM_MODEL", e.target.value)}
                disabled={!editable}
                className="h-10 w-full rounded-md border border-gray-300 px-2 text-sm"
              >
                <option value="">Automatic (the first model loaded)</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="API token (only if LM Studio requires one)"
              source={s.LLM_API_KEY.source}
              hint="Leave blank when Require Authentication is off in LM Studio."
            >
              {keyField("LLM_API_KEY", "Paste the token from LM Studio > Developer > Manage Tokens")}
            </Field>
            <Field
              label="Wait for an answer (seconds)"
              source={s.LLM_TIMEOUT.source}
              hint="Raise this for a large or slow model."
            >
              <Input
                inputMode="numeric"
                value={form.LLM_TIMEOUT ?? ""}
                onChange={(e) => set("LLM_TIMEOUT", e.target.value.replace(/\D/g, ""))}
                disabled={!editable}
              />
            </Field>
          </div>
          <Result result={tests.lmstudio ?? null} />
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => test("lmstudio")} disabled={testing !== null}>
                {testing === "lmstudio" ? "Testing..." : "Test connection"}
              </Button>
              <Button
                onClick={() => save("llm", ["LLM_ENABLED", "LLM_BASE_URL", "LLM_MODEL", "LLM_TIMEOUT", "LLM_API_KEY"])}
                disabled={saving !== null}
              >
                {saving === "llm" ? "Saving..." : saved === "llm" ? "Saved" : "Save"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* AeroDataBox */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Flight status (AeroDataBox)</CardTitle>
            {status(Boolean(s.AERODATABOX_API_KEY.value), usage?.flight_status, "lookups")}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600">
            Alerts for delays, gate and terminal changes, cancellations and diversions, on Southwest and every other
            airline. The free plan covers about 600 lookups a month, which is plenty for a family&apos;s trips: each
            flight uses roughly 10 to 15.
          </p>
          <Steps>
            <li>
              Create a free account at <Ext href="https://rapidapi.com/auth/sign-up">rapidapi.com</Ext>.
            </li>
            <li>
              Open the <Ext href="https://rapidapi.com/aedbx-aedbx/api/aerodatabox">AeroDataBox API page</Ext> (or search
              RapidAPI for &quot;AeroDataBox&quot;), click <b>Pricing</b>, and subscribe to the free <b>Basic</b> plan.
              No card is needed for Basic.
            </li>
            <li>
              Go to the <b>Endpoints</b> tab. In the code example on the right, copy the value after{" "}
              <code>X-RapidAPI-Key</code>. That&apos;s your key.
            </li>
            <li>
              Paste it below and click <b>Test key</b> (uses 1 lookup), then <b>Save</b>.
            </li>
          </Steps>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-3">
              <Field label="RapidAPI key" source={s.AERODATABOX_API_KEY.source}>
                {keyField("AERODATABOX_API_KEY", "Paste your X-RapidAPI-Key")}
              </Field>
            </div>
            <Field label="Alert when departure moves by (minutes)" source={s.FLIGHT_STATUS_DELAY_MINUTES.source}>
              <Input
                inputMode="numeric"
                value={form.FLIGHT_STATUS_DELAY_MINUTES ?? ""}
                onChange={(e) => set("FLIGHT_STATUS_DELAY_MINUTES", e.target.value.replace(/\D/g, ""))}
                disabled={!editable}
              />
            </Field>
            <Field
              label="Lookups allowed per month"
              source={s.FLIGHT_STATUS_MONTHLY_LIMIT.source}
              hint="Stays under the free plan's 600."
            >
              <Input
                inputMode="numeric"
                value={form.FLIGHT_STATUS_MONTHLY_LIMIT ?? ""}
                onChange={(e) => set("FLIGHT_STATUS_MONTHLY_LIMIT", e.target.value.replace(/\D/g, ""))}
                disabled={!editable}
              />
            </Field>
          </div>
          <Result result={tests.aerodatabox ?? null} />
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => test("aerodatabox")} disabled={testing !== null}>
                {testing === "aerodatabox" ? "Testing..." : "Test key"}
              </Button>
              <Button
                onClick={() =>
                  save("aero", ["AERODATABOX_API_KEY", "FLIGHT_STATUS_DELAY_MINUTES", "FLIGHT_STATUS_MONTHLY_LIMIT"])
                }
                disabled={saving !== null}
              >
                {saving === "aero" ? "Saving..." : saved === "aero" ? "Saved" : "Save"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* SerpApi */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Prices on every airline (Google Flights via SerpApi)</CardTitle>
            {status(Boolean(s.SERPAPI_API_KEY.value), usage?.google_flights, "searches")}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600">
            Fare watches on every airline, and price-drop alerts on trips you booked with other airlines. The free plan
            has 250 searches a month. Each fare watch uses about 2 a day and each booked trip about 1 every 2 days, so
            the free plan fits 2 to 3 watches plus your trips.
          </p>
          <Steps>
            <li>
              Create a free account at <Ext href="https://serpapi.com/users/sign_up">serpapi.com</Ext> and confirm your
              email and phone number.
            </li>
            <li>
              The free plan starts on its own. Open <Ext href="https://serpapi.com/manage-api-key">Your API key</Ext> and
              copy the private key.
            </li>
            <li>
              Paste it below and click <b>Test key</b> (free: it checks your plan without using a search), then{" "}
              <b>Save</b>.
            </li>
          </Steps>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-3">
              <Field label="SerpApi key" source={s.SERPAPI_API_KEY.source}>
                {keyField("SERPAPI_API_KEY", "Paste your SerpApi private key")}
              </Field>
            </div>
            <Field
              label="Searches allowed per month"
              source={s.SERPAPI_MONTHLY_LIMIT.source}
              hint="Stays under the free plan's 250."
            >
              <Input
                inputMode="numeric"
                value={form.SERPAPI_MONTHLY_LIMIT ?? ""}
                onChange={(e) => set("SERPAPI_MONTHLY_LIMIT", e.target.value.replace(/\D/g, ""))}
                disabled={!editable}
              />
            </Field>
            <Field label="Alert when a booked trip drops by ($)" source={s.TRIP_PRICE_DROP_ALERT.source}>
              <Input
                inputMode="numeric"
                value={form.TRIP_PRICE_DROP_ALERT ?? ""}
                onChange={(e) => set("TRIP_PRICE_DROP_ALERT", e.target.value.replace(/\D/g, ""))}
                disabled={!editable}
              />
            </Field>
            <Field label="Re-price booked trips every (hours)" source={s.TRIP_PRICE_CHECK_HOURS.source}>
              <Input
                inputMode="numeric"
                value={form.TRIP_PRICE_CHECK_HOURS ?? ""}
                onChange={(e) => set("TRIP_PRICE_CHECK_HOURS", e.target.value.replace(/\D/g, ""))}
                disabled={!editable}
              />
            </Field>
          </div>
          <Result result={tests.serpapi ?? null} />
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => test("serpapi")} disabled={testing !== null}>
                {testing === "serpapi" ? "Testing..." : "Test key"}
              </Button>
              <Button
                onClick={() =>
                  save("serp", ["SERPAPI_API_KEY", "SERPAPI_MONTHLY_LIMIT", "TRIP_PRICE_DROP_ALERT", "TRIP_PRICE_CHECK_HOURS"])
                }
                disabled={saving !== null}
              >
                {saving === "serp" ? "Saving..." : saved === "serp" ? "Saved" : "Save"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
