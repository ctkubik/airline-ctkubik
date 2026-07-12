import type { Config } from "tailwindcss";

/*
  Tailwind maps onto the "Departure" tokens in globals.css.
  - `gray-*` is remapped to theme-aware slate vars, so pages built with raw
    gray utilities adopt the palette (and dark mode) automatically.
  - `blue-*` is remapped to the coral accent ramp, so existing primary/active
    styling becomes the brand accent without touching every page.
  - Semantic + brand tokens are added for hand-crafted components.
*/

const config: Config = {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
      },
      colors: {
        ground: "var(--ground)",
        surface: "var(--surface)",
        line: "var(--line)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        brand: {
          DEFAULT: "var(--brand)",
          tint: "var(--brand-tint)",
          fg: "var(--on-brand)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          tint: "var(--accent-tint)",
        },
        gold: { DEFAULT: "var(--gold)", tint: "var(--gold-tint)" },
        success: { DEFAULT: "var(--success)", tint: "var(--success-tint)" },
        warning: { DEFAULT: "var(--warning)", tint: "var(--warning-tint)" },
        danger: { DEFAULT: "var(--danger)", tint: "var(--danger-tint)" },
        info: { DEFAULT: "var(--info)", tint: "var(--info-tint)" },

        // Theme-aware remap of the default neutral ramp.
        gray: {
          50: "var(--ground-tint)",
          100: "var(--surface-2)",
          200: "var(--line)",
          300: "var(--line-strong)",
          400: "var(--faint)",
          500: "var(--muted)",
          600: "var(--ink-soft)",
          700: "var(--ink-soft)",
          800: "var(--ink)",
          900: "var(--ink)",
        },
        // Existing "blue" primary/active styling becomes the coral accent.
        blue: {
          50: "#fceee9",
          100: "#f8dbd1",
          200: "#f2bba7",
          300: "#ec957b",
          400: "#e77354",
          500: "#e05a3c",
          600: "#e05a3c",
          700: "#c8492e",
          800: "#a53c26",
          900: "#7f3020",
        },
      },
      borderRadius: {
        md: "var(--radius-sm)",
        lg: "var(--radius)",
        xl: "16px",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
    },
  },
  plugins: [],
};
export default config;
