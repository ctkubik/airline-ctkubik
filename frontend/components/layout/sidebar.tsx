"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Plane,
  LayoutDashboard,
  Users,
  CalendarCheck,
  Settings,
  LogOut,
  Activity,
  Menu,
  X,
  Search,
  UserCog,
  Wallet,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";

const navSections: { heading: string; items: { href: string; label: string; icon: typeof Plane }[] }[] = [
  {
    heading: "Overview",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/activity", label: "Activity", icon: Activity },
    ],
  },
  {
    heading: "Travel",
    items: [
      { href: "/accounts", label: "Accounts", icon: Users },
      { href: "/reservations", label: "Reservations", icon: CalendarCheck },
      { href: "/flights", label: "Flights", icon: Plane },
    ],
  },
  {
    heading: "Savings",
    items: [
      { href: "/fare-watches", label: "Fare Watches", icon: Search },
      { href: "/credits", label: "Travel Credits", icon: Wallet },
    ],
  },
  {
    heading: "Family",
    items: [{ href: "/documents", label: "Documents", icon: FileText }],
  },
  {
    heading: "System",
    items: [
      { href: "/users", label: "Users", icon: UserCog },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<{ username: string; role: string } | null>(null);

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.user && setUser(d.user))
      .catch(() => {});
  }, []);

  async function handleLogout() {
    await fetch("/api/auth", { method: "DELETE" });
    router.push("/login");
    router.refresh();
  }

  const initials = (user?.username || "?").slice(0, 2).toUpperCase();

  return (
    <>
      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 border-b border-[color:var(--line)] bg-[color:var(--surface)] px-4 md:hidden">
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="rounded-[var(--radius-sm)] p-1.5 text-[color:var(--ink-soft)] hover:bg-[color:var(--surface-2)]"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <PlaneMark />
          <span className="font-display text-[15px] font-semibold">Concourse</span>
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden" onClick={() => setOpen(false)} />
      )}

      <aside
        className={cn(
          "fixed left-0 top-0 z-50 flex h-screen w-64 flex-col bg-[color:var(--brand)] text-[color:var(--on-brand)] transition-transform duration-200 md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Wordmark */}
        <div className="flex h-16 items-center justify-between gap-2 px-5">
          <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
            <PlaneMark />
            <div className="leading-none">
              <div className="font-display text-[17px] font-semibold tracking-tight">Concourse</div>
              <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[color:var(--on-brand-muted)]">
                family travel
              </div>
            </div>
          </Link>
          <button onClick={() => setOpen(false)} className="md:hidden text-[color:var(--on-brand-muted)]">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
          {navSections.map((section) => (
            <div key={section.heading}>
              <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-[color:var(--on-brand-muted)]">
                {section.heading}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "group relative flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-[13.5px] font-medium transition-colors",
                        isActive
                          ? "bg-white/[0.08] text-white"
                          : "text-[color:var(--on-brand-muted)] hover:bg-white/[0.05] hover:text-[color:var(--on-brand)]"
                      )}
                    >
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[color:var(--accent)]" />
                      )}
                      <item.icon
                        className={cn(
                          "h-[18px] w-[18px] shrink-0",
                          isActive ? "text-[color:var(--accent)]" : "text-current"
                        )}
                      />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* User + controls */}
        <div className="border-t border-white/10 p-3">
          <div className="flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--accent)] text-[13px] font-semibold text-white">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-[color:var(--on-brand)]">
                {user?.username || "Signed in"}
              </div>
              <div className="text-[11px] capitalize text-[color:var(--on-brand-muted)]">
                {user?.role || "member"}
              </div>
            </div>
            <ThemeToggle />
          </div>
          <button
            onClick={handleLogout}
            className="mt-1 flex w-full items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-[13px] font-medium text-[color:var(--on-brand-muted)] transition-colors hover:bg-white/[0.05] hover:text-[color:var(--on-brand)]"
          >
            <LogOut className="h-[18px] w-[18px]" />
            Sign Out
          </button>
        </div>
      </aside>
    </>
  );
}

// A small navy roundel with a plane — the brand mark.
function PlaneMark() {
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[color:var(--accent)] shadow-sm">
      <Plane className="h-[18px] w-[18px] -rotate-45 text-white" />
    </span>
  );
}
