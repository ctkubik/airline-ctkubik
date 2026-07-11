"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { UserPlus, KeyRound, Trash2, ShieldCheck, User as UserIcon } from "lucide-react";

interface User {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "member";
  is_active: number;
  created_at: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [notAdmin, setNotAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  // Add form state
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/users");
    if (res.status === 403) {
      setNotAdmin(true);
      setLoading(false);
      return;
    }
    if (res.ok) {
      setUsers(await res.json());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, display_name: displayName, role }),
    });
    if (res.ok) {
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("member");
      await load();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error || "Failed to create user");
    }
    setSubmitting(false);
  }

  async function patchUser(id: string, patch: Record<string, unknown>) {
    setError("");
    const res = await fetch(`/api/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error || "Update failed");
    }
    await load();
  }

  async function resetPassword(user: User) {
    const newPassword = window.prompt(`New password for ${user.username} (min 8 characters):`);
    if (!newPassword) return;
    await patchUser(user.id, { password: newPassword });
  }

  async function deleteUser(user: User) {
    if (!window.confirm(`Delete user ${user.username}? This cannot be undone.`)) return;
    setError("");
    const res = await fetch(`/api/users/${user.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error || "Delete failed");
    }
    await load();
  }

  if (loading) {
    return <div className="p-8 text-gray-500">Loading…</div>;
  }

  if (notAdmin) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Users</h1>
        <p className="text-gray-600">
          Only administrators can manage users. Ask your admin if you need your password reset.
        </p>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Users</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage who can log in to this dashboard. Members can use everything except user management.
        </p>
      </div>

      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" /> Add User
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="grid gap-3 md:grid-cols-5">
            <Input
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <Input
              placeholder="Display name (e.g. Grandma)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <Input
              type="password"
              placeholder="Password (min 8 chars)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "member")}
              className="h-10 rounded-md border border-gray-200 bg-white px-3 text-sm"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Adding…" : "Add User"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Users ({users.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-gray-100">
            {users.map((u) => (
              <div key={u.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="flex items-center gap-2 min-w-[200px]">
                  {u.role === "admin" ? (
                    <ShieldCheck className="h-5 w-5 text-blue-600" />
                  ) : (
                    <UserIcon className="h-5 w-5 text-gray-400" />
                  )}
                  <div>
                    <div className="font-medium text-gray-900">
                      {u.display_name || u.username}
                    </div>
                    <div className="text-xs text-gray-500">{u.username}</div>
                  </div>
                </div>
                <Badge variant={u.role === "admin" ? "scheduled" : "default"}>{u.role}</Badge>
                <Badge variant={u.is_active ? "active" : "inactive"}>
                  {u.is_active ? "active" : "disabled"}
                </Badge>
                <div className="ml-auto flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => resetPassword(u)}>
                    <KeyRound className="h-4 w-4 mr-1" /> Reset password
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => patchUser(u.id, { is_active: !u.is_active })}
                  >
                    {u.is_active ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => deleteUser(u)}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>
            ))}
            {users.length === 0 && (
              <p className="py-3 text-sm text-gray-500">
                No users yet. The AUTH_USERNAME/AUTH_PASSWORD login from your .env acts as the
                built-in admin; add accounts here for family members.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
