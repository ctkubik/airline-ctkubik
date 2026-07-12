import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
  Status pills carry a color-coded tint + a soft ring so state reads at a
  glance. Semantic colors are separate from the coral brand accent.
*/
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-5 ring-1 ring-inset",
  {
    variants: {
      variant: {
        default:
          "bg-[color:var(--surface-2)] text-[color:var(--ink-soft)] ring-[color:var(--line)]",
        pending:
          "bg-[color:var(--surface-2)] text-[color:var(--muted)] ring-[color:var(--line)]",
        scheduled: "bg-[color:var(--info-tint)] text-[color:var(--info)] ring-[color:var(--info)]/20",
        checking_in:
          "bg-[color:var(--warning-tint)] text-[color:var(--warning)] ring-[color:var(--warning)]/20",
        success:
          "bg-[color:var(--success-tint)] text-[color:var(--success)] ring-[color:var(--success)]/20",
        failed: "bg-[color:var(--danger-tint)] text-[color:var(--danger)] ring-[color:var(--danger)]/20",
        active:
          "bg-[color:var(--success-tint)] text-[color:var(--success)] ring-[color:var(--success)]/20",
        inactive:
          "bg-[color:var(--surface-2)] text-[color:var(--faint)] ring-[color:var(--line)]",
        accent: "bg-[color:var(--accent-tint)] text-[color:var(--accent-hover)] ring-[color:var(--accent)]/25",
        gold: "bg-[color:var(--gold-tint)] text-[color:var(--gold)] ring-[color:var(--gold)]/25",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
