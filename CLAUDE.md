# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

**This repo currently contains no code — only two design documents.** It is a greenfield project (brewsync 2.0) still at Sprint 0.

- `brewsync-pos-design.md` — the domain model: *what* is being built (§1–§19, includes ERD)
- `brewsync-sprint-plan.md` — the execution plan: *how* it gets built (sprints S0–S10, DoR/DoD, tech standards)

Both are written in Indonesian. Read the design doc before the sprint plan. When implementing anything, cite the relevant `§` section — the docs are the source of truth for domain decisions, and section numbers are referenced from sprint tasks (e.g. `S4-04` → design `§6`).

Do not invent architecture that contradicts these docs. If a doc is ambiguous or silent, say so and ask rather than guessing — several deliberately-deferred areas are listed in design `§11` ("Yang sengaja belum dibahas").

## What this product is

Multi-tenant, multi-outlet SaaS POS. **One core that changes shape** into F&B, Retail, or Service via `BusinessProfile` presets + feature toggles — not three applications.

Stack (planned): React + TypeScript + Zustand (frontend), Express + Prisma + PostgreSQL (backend).

## Planned repo layout (Sprint 0, task S0-01)

pnpm workspaces / Turborepo:

```
apps/api        — Express backend
apps/pos        — React cashier app (tablet-first)
apps/landing    — React public catalog/ordering page (separate bundle from POS)
packages/shared — shared types, Money helper, permission enum constants
packages/db     — Prisma schema + generated client
```

`apps/landing` is intentionally a separate app so its motion/animation bundle never weighs down the cashier app.

## Commands

Scaffolded in Sprint 0. Run from the repo root; all delegate to Turborepo across the workspaces.

**Setup & run**
- `pnpm install` — install workspace deps (mutates the lockfile; ask before running).
- `pnpm db:up` — start the Postgres container (Docker Compose). `pnpm db:down` to stop.
- `pnpm db:migrate` / `pnpm db:generate` / `pnpm db:seed` / `pnpm db:reset` — Prisma against `packages/db`.
- `pnpm dev` — bring up API + frontends in watch mode.

**CI gate** (must be green; `typecheck → lint → test → build`)
- `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build`
- `pnpm format:check` — Prettier.

**Scoping to one workspace / one test**
- `pnpm --filter @brewsync/api test` — run just the API suite (Vitest).
- `pnpm --filter @brewsync/api exec vitest run src/path/to/file.test.ts` — a single file.
- Workspace names: `@brewsync/api`, `@brewsync/pos`, `@brewsync/shared`, `@brewsync/db` (and the `pos` app).

## The seven non-negotiable standards

These are from sprint plan §4 and are checked at code review. Violating them is an architecture bug, not a style nit.

1. **Tenant scoping lives in ONE layer.** A Prisma Client Extension injects `where tenantId` from request context (AsyncLocalStorage); Postgres Row-Level Security is the safety net. **Never write `where: { tenantId }` manually in a service** — that is an automatic PR rejection (sprint plan §2.2).
2. **Money is integer minor units.** `BigInt`/`Int` in Prisma, a `Money` helper in `packages/shared`. No `float` anywhere for money. Rounding happens exactly once, in the bill pipeline.
3. **Ledgers are append-only; balances are derived.** Stock, cash, and loyalty points are never `UPDATE`d. Insert a movement row; balance = `SUM(...)`. There is deliberately **no `stockOnHand` column** — race-updated balance columns were the root cause of data drift in brewsync 1.0.
4. **Events go through a Transactional Outbox.** Business write + `OutboxEvent` row in the same DB transaction; an in-process worker dispatches. Consumers are idempotent on the event `id`. Producers never call consumers directly — POS emits `SaleCompleted` and knows nothing about Accounting.
5. **Feature toggles and permissions are guarded on both sides.** Frontend (`useFeature` / `usePermission`) is UX only; backend (`requireFeature` / `requirePermission`) is the security boundary. FE-only guarding is a bug.
6. **State machines are explicit.** Order, PurchaseOrder, Reservation, Shift transitions are validated in one place. An illegal transition throws — it is never silently accepted.
7. **Snapshot at the right moment.** Item price/name freeze when an order hits `SENT`; PO price/qty freeze at `APPROVED`. Historical reports must not shift when master data is edited.

## Architecture: how the "one core" works

### Vertical behavior is data, not branches

There is no `if (fnb) ... else if (retail)` anywhere. Two data points drive everything:

- **`ProductVariant.fulfillmentType`**: `STOCKED` | `MADE_TO_ORDER` | `SERVICE` — decides whether an item needs stock, a recipe, KDS routing, or a time slot + assigned staff.
- **`BusinessProfile.features`**: booleans (`tables`, `kds`, `recipe`, `barcode`, `serviceScheduling`, `modifiers`, `serviceCharge`, `memberLoyalty`, `purchasing`, `reservation`, `qrOrder`, `onlineOrder`, `landingPage`) set from a preset (`FNB`/`RETAIL`/`SERVICE`/`MIXED`) then overridable per outlet.

Checks read configuration, never a vertical name. One outlet legitimately mixes types (a cafe selling brewed coffee *and* packaged beans). Adding a vertical = new toggle combination, not new code paths. Toggle dependencies: `qrOrder` requires `tables`; `onlineOrder` requires `landingPage`.

### The bill pipeline has a fixed order (design §6)

This is where subtle money bugs live. The order is not negotiable per-transaction:

```
subtotal → item discounts → order discounts → service charge → tax → rounding (once) → total → gratuity (outside total, untaxed)
```

Every non-item component is persisted as an `OrderCharge` row (`kind`, `label`, `basis`, `rate?`, `amount` signed, `taxable`) — not just a final number. Receipts and tax reports aggregate these rows instead of recomputing. Inclusive vs exclusive tax is per-outlet/per-sales-method **configuration**; inclusive extracts net as `gross / (1 + rate)`. Rounding still happens once.

### Order → Bill → Payment are three distinct levels (design §7)

"What was ordered" (`Order`), "what must be paid" (`Bill`, created at `BILLED`), and "how it was paid" (`Payment`, one row per tender) are separate. Split payment = many `Payment` per `Bill`; split bill = many `Bill` per `Order`. Hard invariant to preserve and test: `SUM(bill.total) === order total` after rounding. Refunds are negative `Payment` rows — never hard deletes.

### Channels don't fork the flow

`Order.channel` (`STAFF` | `QR_TABLE` | `ONLINE`) is origin metadata only. QR and online orders land in the same state machine, pipeline, KDS, and events as staff orders. QR uses a random `Table.qrToken` (never `?table=5`), with optional staff-approve and expiry windows for unpaid online orders — all enforced backend-side.

### RBAC is fully dynamic (design §12)

`Permission` (system-defined `domain.action` constants, no `tenantId`) → `Role` (tenant-owned; `isSystem` presets are read-only) → `UserRole` (assignment scoped by optional `outletId`; null = tenant-wide). Effective permissions = union of role permissions for the request's outlet context, cached per session. Never write `if (user.role === 'admin')`. Adding an access rule = add a `Permission` constant + guard the endpoint.

Identity is split: `User` is a global login (email + argon2 hash, unique across the platform); `TenantMembership` holds per-tenant data including the hashed cashier `pinHash` for fast POS device login.

## Build order — do not skip ahead

Sprint plan §5. Dependencies are real; the stated lesson from brewsync 1.0 is that features stacked on a shaky foundation become unpayable debt.

| Sprint | Focus |
|---|---|
| S0 | Repo, tooling, CI, Docker Postgres |
| S1 | Tenant/Outlet, request context, Prisma extension, RLS, auth, outbox skeleton |
| S2 | RBAC, TenantMembership + PIN, BusinessProfile toggles, tenant onboarding |
| S3 | Master product: Category (nested), Unit/UoM, Product → Variant, Modifier, PriceList |
| S4 | Order state machine + bill pipeline |
| S5 | Bill, Payment, split bill/payment, Shift + CashMovement |
| S6 | StockMovement, recursive Recipe/BOM, moving-average COGS, Supplier + PO |
| S7 | SalesMethod, Table/Area, Station + KDS realtime |
| S8 | Reservation, QR + online channels |
| S9 | Landing page + CMS sections + catalog motion |
| S10 | Thermal receipts, PDF/Excel export, reports |

**S0–S2 must be green before any feature sprint.** MVP = S0–S5 + S7. Finish S4 (order + pipeline) before touching payments.

## Testing expectations

Anything touching **money, stock, or tenant scoping requires tests** (sprint plan §3.2). Specifically mandated integration tests: cross-tenant isolation (proven at *both* the extension and RLS layers — the test must go red if scoping is disabled), bill pipeline arithmetic across discount/service-charge/inclusive-exclusive-tax combinations, the split-bill sum invariant, and state machine legality. E2E (Playwright) only for the critical happy path: order → pay → close shift. Every bug gets a reproducing test before the fix.

## Conventions

- **Conventional Commits**, enforced locally via commitlint. Branches: `feat/S3-02-product-crud` (include the sprint task ID), short-lived (< 3 days).
- **PRs under ~400 lines.** One approval to merge; two for foundation layers (tenant scoping, money pipeline, RLS).
- **Vertical slices**: finish a feature DB → API → UI → test rather than all-backend-then-all-frontend.
- TypeScript strict; no stray `any`, no unexplained `@ts-ignore`.
- Zod validation on every endpoint and on env vars at boot.
- Structured logging (pino) carrying `tenantId` and `requestId`.

## Responsive is a requirement, not polish (design §19)

The same codebase serves five contexts with different layout priorities: cashier tablet (landscape, large tap targets ≥44px, product grid + order panel), customer phone (portrait single-column), public catalog (fluid + motion), kitchen display (large screen, readable at distance, no touch), admin desktop (dense tables). Layout must **restructure** for the available space (order panel becomes a bottom-sheet on narrow screens), not merely shrink. Virtualize long product lists; assume mid-range devices.

Catalog motion animates only `transform` and `opacity`, and must honor `prefers-reduced-motion`. Print (thermal 58/80mm) is a separate renderer over the same data, outside the responsive system.
