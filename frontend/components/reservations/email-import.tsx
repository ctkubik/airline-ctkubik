"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Mail } from "lucide-react";

interface Found {
  confirmation_number: string;
  first_name: string;
  last_name: string;
  route?: string;
  depart_date?: string;
  already_added?: boolean;
  include: boolean;
  owner_account_id: string;
}

interface AccountOption {
  id: string;
  display_name: string;
  username: string;
}

// "Add from email": paste a Southwest confirmation email, review what was
// found, then add the reservations. Uses the local LLM when it's on, and a
// confirmation-number pattern match when it isn't.
export function EmailImport({ accounts, onAdded }: { accounts: AccountOption[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [source, setSource] = useState<"llm" | "pattern" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function reset() {
    setText("");
    setFound(null);
    setSource(null);
    setError("");
  }

  async function read() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/reservations/parse-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(body?.error || "Couldn't read that email");
      return;
    }
    setSource(body.source);
    setFound(
      (body.reservations as Found[]).map((r) => ({ ...r, include: !r.already_added, owner_account_id: "" }))
    );
  }

  function update(i: number, patch: Partial<Found>) {
    setFound((prev) => prev && prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function addSelected() {
    if (!found) return;
    const chosen = found.filter((r) => r.include);
    if (chosen.some((r) => !r.first_name.trim() || !r.last_name.trim())) {
      setError("Fill in the first and last name for each reservation you're adding.");
      return;
    }
    setBusy(true);
    for (const r of chosen) {
      await fetch("/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmation_number: r.confirmation_number,
          first_name: r.first_name,
          last_name: r.last_name,
          owner_account_id: r.owner_account_id,
        }),
      });
    }
    setBusy(false);
    setOpen(false);
    reset();
    onAdded();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Mail className="mr-2 h-4 w-4" /> Add from email
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add from a confirmation email</DialogTitle>
        </DialogHeader>
        {found === null ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-gray-600">
              Open the Southwest confirmation email, select all of it, copy, and paste it here.
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              className="w-full rounded-md border border-gray-300 p-3 text-sm"
              placeholder="Paste the whole email here"
            />
            {error && <p className="text-sm text-red-700">{error}</p>}
            <Button onClick={read} disabled={busy || !text.trim()} className="w-full">
              {busy ? "Reading..." : "Find reservations"}
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {found.length === 0 ? (
              <p className="text-sm text-gray-700">
                No confirmation numbers found. Make sure you pasted the whole email, or add the reservation by hand.
              </p>
            ) : (
              <>
                <p className="text-sm text-gray-600">
                  {source === "llm"
                    ? "Found these. Check the names match the email, then add them."
                    : "Found these confirmation numbers. The local AI is off, so type in a passenger's first and last name for each."}
                </p>
                {found.map((r, i) => (
                  <div key={r.confirmation_number} className="space-y-2 rounded-lg border border-gray-200 p-3">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input
                        type="checkbox"
                        checked={r.include}
                        onChange={(e) => update(i, { include: e.target.checked })}
                      />
                      {r.confirmation_number}
                      {r.route && <span className="font-normal text-gray-500">{r.route}</span>}
                      {r.depart_date && <span className="font-normal text-gray-500">{r.depart_date}</span>}
                      {r.already_added && (
                        <span className="text-xs font-normal text-amber-700">already added</span>
                      )}
                    </label>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Input
                        value={r.first_name}
                        onChange={(e) => update(i, { first_name: e.target.value })}
                        placeholder="First name"
                      />
                      <Input
                        value={r.last_name}
                        onChange={(e) => update(i, { last_name: e.target.value })}
                        placeholder="Last name"
                      />
                      {accounts.length > 0 && (
                        <select
                          value={r.owner_account_id}
                          onChange={(e) => update(i, { owner_account_id: e.target.value })}
                          className="rounded-md border border-gray-300 px-2 py-2 text-sm"
                          aria-label="Whose trip"
                        >
                          <option value="">Alerts: everyone</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              Alerts: {a.display_name || a.username}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
            {error && <p className="text-sm text-red-700">{error}</p>}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setFound(null)} disabled={busy}>
                Back
              </Button>
              {found.length > 0 && (
                <Button onClick={addSelected} disabled={busy || !found.some((r) => r.include)} className="flex-1">
                  {busy ? "Adding..." : `Add ${found.filter((r) => r.include).length} reservation(s)`}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
