import { Badge } from "@/components/ui/badge";

const statusLabels: Record<string, string> = {
  pending: "Pending",
  scheduled: "Scheduled",
  checking_in: "Checking In",
  success: "Checked In",
  failed: "Failed",
};

// A small status dot inside the pill, colored by state, for at-a-glance scanning.
const dotColor: Record<string, string> = {
  pending: "var(--muted)",
  scheduled: "var(--info)",
  checking_in: "var(--warning)",
  success: "var(--success)",
  failed: "var(--danger)",
};

export function StatusBadge({ status }: { status: string }) {
  const variant = status as "pending" | "scheduled" | "checking_in" | "success" | "failed";
  return (
    <Badge variant={variant}>
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: dotColor[status] || "var(--muted)" }}
        aria-hidden
      />
      {statusLabels[status] || status}
    </Badge>
  );
}
