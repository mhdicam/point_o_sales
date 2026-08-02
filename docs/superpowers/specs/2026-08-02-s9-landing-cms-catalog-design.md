# S9 — Landing page + CMS + katalog motion — design spec

**Date:** 2026-08-02
**Sprint:** S9 (design §17, sprint plan §15). Includes the deferred **S8-07** (ONLINE checkout, §16.3).
**Status:** approved for implementation (brainstormed with user 2026-08-02).

## Goal

A public per-tenant landing page (`features.landingPage`) that runs in one of two modes
from a single toggle (§17):

- **`orderingEnabled` OFF → catalog-only.** Showcase menu/produk, foto, harga, jam buka.
  No checkout button.
- **`orderingEnabled` ON → take-order.** Same catalog, items go to a cart → checkout →
  `Order.channel = ONLINE` (§16.3).

Admin manages content via section-based **CMS-lite** (§17.1): drag-order sections, edit per
block, DRAFT→PUBLISHED publish flow so half-finished edits never leak. Catalog pulls products
**live from master** (§3) — never copied. Motion (§17.2): scroll reveal, hover lift, hero
parallax, skeleton shimmer — `transform`/`opacity` only, honor `prefers-reduced-motion`.

## Decisions (from brainstorming)

1. **Full S9 this session** — all 7 tasks, sliced vertically (DB→API→UI→test), each its own PR.
2. **S8-07 ONLINE checkout lands with S9-04** — `orderingEnabled` ON path creates `channel=ONLINE`
   orders (pickup/delivery + unpaid-expiry).
3. **Framer Motion** in `apps/landing` only (isolated bundle, never POS), shared variants (§17.2).
4. **Unpaid-online expiry = new explicit `EXPIRED` terminal state** on the Order machine
   (`OPEN→EXPIRED` only), driven by a scheduled sweep. Chosen over reusing VOID for report
   clarity; still one explicit transition (standard #6), sweep is the only caller.

## Already exists (verified during exploration)

- `PERMISSIONS.LANDING_MANAGE = 'landing.manage'` — `packages/shared/src/permissions.ts:63`.
- `landingPage` + `onlineOrder` feature flags with `onlineOrder → landingPage` dependency —
  `packages/shared/src/features.ts:42,58`.
- `apps/landing` app (built S8-08 for QR ordering) — reuse its api-client, cart store pattern,
  pure view-model seam, Money formatting, index.css tokens.
- Public pre-tenant route pattern (`/qr`, `/pin`, `/onboarding`) mounted BEFORE tenant middleware
  — `apps/api/src/app.ts`.
- `runUnscoped` sanctioned unscoped read (used by `qr-order.service.ts` `resolveTable`).
- `ProductService.list()` — the dine-in catalog path QR's menu reuses; CATALOG section reuses it.
- `ORDER_CREATED` event (added S8-06 for customer channels).

## Data model (S9-01, design §17.1 + ERD)

```prisma
model LandingPage {
  id              String            @id @default(uuid())
  tenantId        String
  outletId        String?           // null = per-tenant; §17.1 per-tenant OR per-outlet
  slug            String            // public path (no subdomain — path /p/:slug)
  title           String
  description     String?
  theme           Json?             // brand: warna, font, logo
  orderingEnabled Boolean           @default(false)  // mirror features.onlineOrder for THIS page
  status          LandingPageStatus @default(DRAFT)
  publishedAt     DateTime?
  updatedBy       String?
  updatedAt       DateTime          @updatedAt
  outlet          Outlet?           @relation(fields: [outletId], references: [id])
  tenant          Tenant            @relation(fields: [tenantId], references: [id])
  sections        LandingSection[]

  @@unique([tenantId, slug])
  @@index([outletId])
}

model LandingSection {
  id            String             @id @default(uuid())
  landingPageId String
  type          LandingSectionType
  position      Int                @default(0)  // admin drag-order, unique per page
  title         String?            // admin-facing label
  content       Json               // per-type content (hero/catalog/hours/...)
  isVisible     Boolean            @default(true)
  landingPage   LandingPage        @relation(fields: [landingPageId], references: [id])

  @@unique([landingPageId, position])
  @@index([landingPageId])
}

enum LandingSectionType { HERO CATALOG ABOUT GALLERY CONTACT HOURS MAP CUSTOM }
enum LandingPageStatus  { DRAFT PUBLISHED }
```

Rationale:
- **slug, not subdomain** — path `/p/:slug` deployable on existing infra (no wildcard DNS/cert).
- **orderingEnabled stored on page** — admin stages it with a draft publish; public reads the
  published value. `onlineOrder` feature flag stays the master kill-switch in the service.
- **DRAFT|PUBLISHED + publishedAt** — public endpoint reads PUBLISHED only; opaque 404 otherwise.
- **position unique per page** — DB-enforced drag-order.
- **content Json per type** — heterogeneous sections; each type gets one renderer + one Zod schema.
- **tenantId never written manually** — Prisma extension + RLS (standard #1). slug resolved
  unscoped like qrToken, then binds to resolved tenant.
- No version/history table (not required by §17.1).

Migration `20260804xxxx00_s8_landing_page`: 2 CREATE TABLE + 2 CREATE TYPE + RLS DO-block
(mirror the reservation migration). `prisma validate && generate`, rebuild `@brewsync/db`.

## API

### Public read — `GET /p/:slug` (pre-tenant, rate-limited)
`PublicLandingService`:
1. `resolveSlug(slug)` — sanctioned `runUnscoped` findUnique on `[tenantId, slug]`; must be
   PUBLISHED else opaque `notFound('LANDING_INVALID')` (never leak draft vs missing).
2. `buildPage(resolved)` — bind tenant ctx, assert `landingPage` feature ON (else same opaque 404),
   read sections in position order; CATALOG sections resolve selections via `ProductService.list()`.

Response: `{ page: {slug,title,description,theme,orderingEnabled}, outlet: {name}, sections: [...] }`.
CATALOG section `content = { categoryIds?, productIds? }` → resolved to live products/variants
(price string). Deactivated products drop silently (opaque, like QR).

### Public checkout — `POST /p/:slug/orders` (S8-07, pre-tenant, rate-limited)
Body `{ items: [{variantId, qty, modifierIds?}], salesMethod: 'PICKUP'|'DELIVERY'|null }`.
- `orderingEnabled` must be true (service is the security gate — standard #5).
- No `tableId`; salesMethod resolves to a **tenant-owned active** PICKUP/DELIVERY method
  (no client prices). Unknown → 400.
- Creates `channel=ONLINE` order via `createOnlineInTx` (mirrors S8-06 sendInTx pattern).
- Emits `ORDER_CREATED` (+`ORDER_SENT` if auto-accept) in same tx (standard #4).
- Same per-IP rate limiter as QR (`createRateLimit`).

### Expiry sweep (S8-07)
New Order terminal state `EXPIRED`; `OPEN→EXPIRED` is the only transition into it. A scheduled
sweep transitions unpaid ONLINE orders past the window, emits `ORDER_EXPIRED`. State-machine
change is one explicit transition; sweep is the only caller. Reports distinguish EXPIRED from VOID.

### CMS admin — authenticated, `landing.manage`-guarded (mounted after tenant middleware)
```
GET    /landing                → tenant page + sections (draft)
PUT    /landing                → page meta (title, description, theme, orderingEnabled)
POST   /landing/sections       → add section
PUT    /landing/sections/:id   → update section (type fixed; content, title, isVisible)
DELETE /landing/sections/:id   → remove
PUT    /landing/sections/order → reorder [{id, position}] (whole-list tx, unique positions)
POST   /landing/publish        → DRAFT→PUBLISHED, set publishedAt
POST   /landing/unpublish      → PUBLISHED→DRAFT (makes public 404)
```
All `requirePermission(LANDING_MANAGE)`, Zod on every body. Ensure the system-admin preset role
gets LANDING_MANAGE at provisioning (check role.service.ts).

## Frontend

### apps/landing (public render + modes + motion)
Routes: `/` LandingHome, `/p/:slug/checkout`, `/p/:slug/confirm`; existing `/t/:token` QR untouched.
- **LandingHome** — fetch `GET /p/:slug`, apply `theme` as CSS vars, render sections via a
  **renderer map** (one component per type). CATALOG renderer shows master-fed products.
- **Mode (S9-04):** `orderingEnabled` toggles add-to-cart controls (pure render).
- **Cart/checkout (S8-07):** reuse `qr.store.ts` cart pattern (extract shared landing cart store);
  client-side `{variantId, qty}[]`, no authoritative money math (standard #2); POST `/p/:slug/orders`;
  confirm renders server totals.
- **Pure seam:** `page-view.ts` (mirrors `cart-view.ts`) — section grouping, catalog previews via
  `Money`, empty states, reduced-motion flag. Unit-tested, no API.
- **Motion (S9-05):** framer-motion (landing only). Shared variants `src/lib/motion.ts`
  (fadeUp, stagger, heroParallax). whileInView reveal, hover lift, thin hero parallax, shimmer.
  transform/opacity only. `useReducedMotion()` collapses.
- **Perf/a11y (S9-06):** images `loading="lazy"` + srcSet/sizes (verify ProductImage.url resize
  support; else defer srcSet). Virtualize long lists. 60fps mid-range: transform/opacity, IO reveal.

### apps/pos (CMS admin, S9-02)
`/landing → LandingAdminScreen` under AdminLayout:
- Section list (position order), up/down reorder (touch-reliable; drag as later enhancement).
- Per-type section editor (hero title+CTA; catalog category/product picker from master; hours rows).
- Page meta + theme + orderingEnabled toggle.
- Publish/Unpublish with DRAFT/PUBLISHED badge; preview via public URL.
- `useLandingStore` Zustand → `/landing` API. **No motion library in POS bundle.**

### SEO (S9-07)
Meta title/description from LandingPage, Open Graph tags, `sitemap.xml` per published page.

## Testing (CLAUDE.md §3.2 — money, stock, tenant scoping)

- **Cross-tenant isolation** (red if scoping disabled, both extension + RLS layers): slug for A
  resolves only to A; B's slug unreachable from A; resolved tenant comes from slug, not client.
- **Publish opacity:** DRAFT → public 404; PUBLISHED → 200; unpublish → 404. Draft never leaks.
- **Feature gate:** `landingPage` OFF → 404 even with valid published slug.
- **Catalog snapshot:** deactivated product drops; prices reflect live master.
- **ONLINE order:** orderingEnabled OFF → checkout rejected; ON → channel=ONLINE, no tableId,
  resolves PICKUP/DELIVERY method; unknown method → 400.
- **Expiry state machine:** OPEN→EXPIRED legal; SENT→EXPIRED / PAID→EXPIRED throw
  (added to order.state.test.ts). Sweep only transitions OPEN online orders past window.
- **Pure seam:** page-view.ts unit tests.
- DB-backed `landing.test.ts` authored + CI-ready (needs Postgres; not run locally).

## Build order — 7 slices (each a commit, PR <~400 lines)

| # | Task | Approvals |
|---|---|---|
| 1 | S9-01 models + RLS migration | 2 (RLS) |
| 2 | S9-03 CATALOG-from-master public read | 2 (public unauth + cross-tenant) |
| 3 | S9-02 CMS admin API + POS LandingAdminScreen | 1 |
| 4 | S9-04 + S8-07 ordering mode + ONLINE checkout + EXPIRED sweep | 2 (order/money pipeline) |
| 5 | S9-05 Framer Motion + shared variants | 1 |
| 6 | S9-06 perf/a11y | 1 |
| 7 | S9-07 SEO | 1 |

## Standards checkpoints

- **#1** slug resolve is the one sanctioned runUnscoped; everything else binds resolved tenant;
  no manual `where: { tenantId }`.
- **#2** FE never computes authoritative amounts; previews via Money; order total from server.
- **#4** ORDER_CREATED/ORDER_SENT/ORDER_EXPIRED in same tx.
- **#5** orderingEnabled/landingPage are FE UX; service is the security boundary.
- **#6** EXPIRED is one explicit terminal transition; illegal transitions throw.
- **#7** online item price/name freeze at SENT — existing snapshot machinery, no new logic.

## Out of scope (deferred)

- Subdomain routing (path `/p/:slug` now).
- Online payment gateway (pay-at-pickup/later per §16.3 MVP).
- Reservation block on landing (§17.3) unless quick.
- Multi-version page history.

## Verification (per-workspace — root turbo fails here)

`prisma validate/generate` → build db+shared → api (typecheck + `vitest run src/services` +
state tests + lint + build) → pos (typecheck+tests+lint+build) → landing
(typecheck+tests+lint+build). `pnpm install` for framer-motion — **ask first** (lockfile).
Corepack: `"/c/Program Files/nodejs/corepack" pnpm --filter @brewsync/<ws> ...`;
prisma needs dummy `DATABASE_URL`+`DIRECT_DATABASE_URL` inline.
