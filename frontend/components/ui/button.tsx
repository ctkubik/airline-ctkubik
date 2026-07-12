import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--surface)] disabled:pointer-events-none disabled:opacity-50 active:translate-y-px select-none",
  {
    variants: {
      variant: {
        default:
          "bg-[color:var(--accent)] text-white shadow-sm hover:bg-[color:var(--accent-hover)] hover:shadow-md",
        brand:
          "bg-[color:var(--brand)] text-[color:var(--on-brand)] shadow-sm hover:brightness-125",
        destructive: "bg-[color:var(--danger)] text-white shadow-sm hover:brightness-95",
        outline:
          "border border-[color:var(--line-strong)] bg-[color:var(--surface)] text-[color:var(--ink-soft)] hover:bg-[color:var(--surface-2)] hover:border-[color:var(--faint)]",
        ghost: "text-[color:var(--ink-soft)] hover:bg-[color:var(--surface-2)]",
      },
      size: {
        default: "h-10 px-4 text-sm",
        sm: "h-8 px-3 text-[13px]",
        lg: "h-12 px-6 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  )
);
Button.displayName = "Button";

export { Button, buttonVariants };
