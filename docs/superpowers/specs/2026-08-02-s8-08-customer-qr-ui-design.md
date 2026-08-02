# S8-08 — Customer QR ordering UI (`apps/landing`)

## Context

Design §16.2 + §19. A customer scans the QR printed on a table; the URL is
`order.<tenant>.brewsync.app/t/{qrToken}`. The page resolves that token to a
specific table + outlet, shows the outlet's dine-in menu, lets the customer
build a cart and place an order, and confirms it. The backend seam already
exists (S8-06): two **public, unauthenticated** endpoints keyed by the token —
`GET /qr/:token` (table + menu) and `POST /qr/:token/orders` (place order).
This slice is the **frontend only**; no API or DB change.

Per design §19 the customer context is **phone portrait, single-column,
thumb-friendly, with a smooth checkout** — a different layout priority from the
cashier tablet. Per the "one core" bundle strategy (CLAUDE.md, planned layout),
the customer-facing motion/animation bundle is intentionally kept **out of the
cashier app** so it never weighs down the POS. S9 formalizes `apps/landing` as
the public catalog/ordering app; this slice **scaffolds that workspace now** and
lands the QR ordering flow as its first feature.

## Decision: new `apps/landing` workspace

The POS app (`apps/pos`) is entirely auth-gated (every route sits under
`RequireScope`). The customer flow is public and has an opposite layout
priority. Rather than bolt a public route tree onto the cashier app and later
migrate it, we create `apps/landing` now — the workspace the planned repo layout
already reserves for exactly this. It mirrors the POS app's toolchain (Vite +
React + TS strict + Tailwind + Vitest) so CI, lint, and the shared `tsconfig`
base apply unchanged. It depends only on `@brewsync/shared` (for `Money.format`
and shared types) — never on `@brewsync/db` or the API internals.

Scope guard: the scaffold is deliberately minimal — one feature (QR ordering),
no CMS/catalog-motion work (that is S9). The animation budget here is limited to
`transform`/`opacity` transitions honoring `prefers-reduced-motion`, reusing the
CSS token setup copied from POS.

## Architecture

```
apps/landing/
  package.json            @brewsync/landing; scripts mirror @brewsync/pos
  tsconfig.json           extends ../../tsconfig.base.json (strict)
  tsconfig.node.json      vite/vitest/tailwind/postcss config typing
  vite.config.ts          /api proxy in dev (same-origin), vitest jsdom
  tailwind.config.ts      phone-first tokens (reuses POS palette + tap sizing)
  postcss.config.js
  index.html              viewport-fit=cover, portrait
  src/
    main.tsx              RouterProvider
    index.css             design tokens + reduced-motion (copied from POS)
    vitest.setup.ts       @testing-library/jest-dom
    router.tsx            /t/:token, /t/:token/confirm, * → not-found
    lib/
      api-client.ts       token-scoped fetch (no auth bridge, auth:false always)
      qr-types.ts         wire types for the two QR responses
      cart-view.ts        PURE: cart math-free view-model + tests
    stores/
      qr.store.ts         Zustand: menu load + cart + placeOrder
    routes/
      MenuScreen.tsx       resolve token → menu, product list, add-to-cart
      CartSheet.tsx        bottom-sheet cart (thumb-friendly)
      ConfirmScreen.tsx    post-order confirmation (renders server totals)
      NotFoundScreen.tsx   opaque "QR not valid" (maps QR_INVALID)
    components/
      MenuItemRow.tsx, QtyStepper.tsx, MoneyText.tsx
```

### Data flow

1. `MenuScreen` reads `:token` from the route, calls `qr.store.loadMenu(token)`
   → `GET /qr/:token`. On `QR_INVALID` (404) it routes to `NotFoundScreen`
   (opaque — never distinguishes disabled/expired/nonexistent, matching the
   backend's deliberate opacity).
2. The cart lives entirely client-side as `{ variantId, qty }[]` plus the menu's
   price strings **for display only**. No money math on the client (standard #2)
   — line/total _previews_ use `Money.format` over the server-provided per-unit
   price × qty via `Money.mulQty` (BigInt, from `@brewsync/shared`), never float.
   The **authoritative** total is whatever the server returns on placement.
3. Checkout calls `qr.store.placeOrder()` → `POST /qr/:token/orders` with
   `{ items: [{variantId, qty}] }`. Response `{ order, accepted }` is stashed and
   the router navigates to `/t/:token/confirm`, which renders `order.summary`
   (server-computed) and an accepted/pending message from `accepted`.

### The pure seam: `cart-view.ts`

Mirrors `apps/pos/src/lib/order-view.ts`: a pure, unit-tested module between the
wire types and React. It builds the menu view-model (group variants under their
product, attach cover image + category) and the cart view-model (join cart
entries to menu rows, produce display line labels + a `Money`-formatted line
preview). It does **no** authoritative money math and calls no API — it takes
the menu payload + cart array and returns render-ready structures. Tests cover:
grouping, price-preview formatting via `Money`, empty cart, and a cart entry
whose variant is missing from the menu (defensive drop).

### api-client (landing variant)

A trimmed copy of the POS client: same uniform-error unwrap into `ApiError`
(branch on `err.code === 'QR_INVALID'` / `'QR_RATE_LIMITED'`), same BigInt-safe
string handling, but **no auth bridge** — every request is `auth:false`
(the endpoints reject nothing on auth; they key on the path token). `API_BASE`
= `import.meta.env.VITE_API_URL ?? '/api'`, proxied in dev by Vite.

## Responsive / accessibility (design §19)

- Single-column, `max-w`-constrained, portrait-first. Tap targets ≥44px via the
  copied `min-h-tap`/`min-w-tap` tokens.
- Cart is a **bottom-sheet** (fixed, slides up) — the narrow-screen restructure
  §19 mandates, not a shrunk side panel.
- Motion animates only `transform`/`opacity` and honors
  `prefers-reduced-motion` (the copied `index.css` media query).
- `NON_JSON_RESPONSE` / network errors surface as a legible retry banner.

## Standards checkpoints

- **#2 money:** the FE never computes an authoritative amount. Line previews use
  `Money.mulQty` + `Money.format` on server price strings; the order total is
  read from `order.summary` (server pipeline). No float, no `Math.round`
  (eslint `no-restricted-syntax` forbids it — same root config applies).
- **#5 both-sides guard:** the page is UX only; the security boundary is the
  backend token resolve + in-service `qrOrder` assertion (S8-06). The UI adds no
  trust.
- **#6 state machine:** untouched — the UI only POSTs; accept/send stays server-side.
- Bundle isolation: landing depends on `@brewsync/shared` only. No POS import,
  no `@brewsync/db`.

## Out of scope (later slices)

- ONLINE channel / catalog browse without a table — **S8-07 / S9** (`landingPage`).
- CMS sections, hero, catalog motion polish — **S9**.
- QR _payment_ online-gateway — out of MVP (pay-at-cashier already works).
- Reservation booking UI — separate S8 FE slice.

## Verification

Per-workspace (root turbo fails here — memory note):

```bash
"/c/Program Files/nodejs/corepack" pnpm --filter @brewsync/landing exec tsc -p tsconfig.json --noEmit
"/c/Program Files/nodejs/corepack" pnpm --filter @brewsync/landing exec vitest run
"/c/Program Files/nodejs/corepack" pnpm --filter @brewsync/landing exec eslint src
"/c/Program Files/nodejs/corepack" pnpm --filter @brewsync/landing build
```

Gate: typecheck clean, `cart-view` unit tests green, lint clean, Vite build
succeeds. Adding the workspace mutates the lockfile via `pnpm install` — **ask
before running** (CLAUDE.md).
