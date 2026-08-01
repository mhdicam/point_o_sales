import type { Config } from 'tailwindcss'

/**
 * Tablet-first design tokens (design §19). Breakpoints restructure layout for
 * the five contexts; the admin screens here target tablet landscape and desktop
 * but degrade to a single-column stack on narrow phones.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Sourced from CSS custom properties in index.css so a future theme
        // switch changes one place, not the Tailwind config.
        brand: 'rgb(var(--color-brand) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-muted': 'rgb(var(--color-surface-muted) / <alpha-value>)',
        ink: 'rgb(var(--color-ink) / <alpha-value>)',
        'ink-muted': 'rgb(var(--color-ink-muted) / <alpha-value>)',
        line: 'rgb(var(--color-line) / <alpha-value>)',
        danger: 'rgb(var(--color-danger) / <alpha-value>)',
      },
      minHeight: {
        // Standard tap target for the cashier tablet (design §19 ≥44px).
        tap: '44px',
      },
      minWidth: {
        tap: '44px',
      },
    },
  },
  plugins: [],
} satisfies Config
