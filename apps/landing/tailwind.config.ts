import type { Config } from 'tailwindcss'

/**
 * Phone-portrait-first design tokens (design §19). The customer QR context is a
 * single-column, thumb-friendly page — the opposite layout priority from the
 * cashier tablet — so the default frame is narrow and tap targets are large.
 * The palette mirrors the POS app (sourced from CSS custom properties in
 * index.css) so a future shared theme changes one place.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: 'rgb(var(--color-brand) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-muted': 'rgb(var(--color-surface-muted) / <alpha-value>)',
        ink: 'rgb(var(--color-ink) / <alpha-value>)',
        'ink-muted': 'rgb(var(--color-ink-muted) / <alpha-value>)',
        line: 'rgb(var(--color-line) / <alpha-value>)',
        danger: 'rgb(var(--color-danger) / <alpha-value>)',
      },
      minHeight: {
        // Thumb-friendly tap target for the customer phone (design §19 ≥44px).
        tap: '44px',
      },
      minWidth: {
        tap: '44px',
      },
      maxWidth: {
        // The single-column customer frame; centered on larger screens.
        phone: '32rem',
      },
    },
  },
  plugins: [],
} satisfies Config
