# Contributing to brewsync

This document covers the folder structure, conventions, and workflow for brewsync 2.0 development.

## Repository structure

```
apps/
  api/        Express backend
  pos/        React cashier app (tablet-first)
  landing/    React public catalog/ordering page (separate bundle)

packages/
  shared/     Shared types, Money helper, permission enum constants
  db/         Prisma schema + generated client
```

`apps/landing` is intentionally a separate app so its motion/animation bundle never weighs down the cashier app.

## Backend structure (apps/api)

**Vertical slices**: finish a feature DB → API → UI → test rather than all-backend-then-all-frontend.

```
src/
  routes/         HTTP routes (thin, delegate to services)
  middleware/     Express middleware (tenant, permission, feature guards)
  services/       Business logic (tenant-scoped, no direct `where: { tenantId }`)
  config.ts       Env validation (zod)
  app.ts          Express app factory (testable without binding a port)
  index.ts        Boot script (binds port, starts outbox worker)
  http-error.ts   Typed error factory (unauthorized, forbidden, notFound, ...)
  logger.ts       Structured logging (pino)

tests/          Integration tests (hit real Postgres, use supertest)
```

### Middleware order is load-bearing

Everything mounted **before** the tenant middleware is reachable without a token. Adding a route above that line is a security decision, not a formatting one. See [apps/api/src/app.ts:createApp](apps/api/src/app.ts).

### Services are tenant-scoped by default

Standard #1 (CLAUDE.md): tenant scoping lives in ONE layer. A Prisma Client Extension injects `where tenantId` from request context; Postgres RLS is the safety net. **Never write `where: { tenantId }` manually in a service** — that is an automatic PR rejection. The only permitted locations are `packages/db/src/**` (the extension itself) and `**/*.test.ts` / `**/tests/**` (to simulate attacks).

An ESLint rule enforces this:
```js
{ selector: 'Literal[value="tenantId"]', message: 'Write where: { tenantId } in services is forbidden (standard #1). The Prisma Client Extension injects it.' }
```

Services operate on a `BrewsyncClient` (the extended Prisma client), **not** on `PrismaClient`.

## Frontend structure (apps/pos, apps/landing)

**Feature-based folders** (not `components/`, `hooks/`, `utils/` at the root):

```
src/
  features/
    orders/
      components/
      hooks/
      OrderScreen.tsx
      api.ts          React Query mutations/queries for this domain
    products/
      ...
  shared/
    components/       Truly shared UI (Button, Modal, etc.)
    hooks/            Truly shared logic (usePermission, useFeature)
  app/
    Router.tsx
    App.tsx
```

A feature owns its components, hooks, and API client. Move something to `shared/` only when a second feature needs it.

## Conventions

### Git workflow

- **Conventional Commits**, enforced locally via commitlint.
- Branch naming: `feat/S3-02-product-crud` (include the sprint task ID when implementing a planned task).
- Branches are short-lived (< 3 days). Merge to `main` frequently.
- PRs under ~400 lines. Split large work.
- One approval to merge; **two** for foundation layers (tenant scoping, money pipeline, RLS).

### TypeScript

- Strict mode.
- No stray `any`.
- No unexplained `@ts-ignore` — every ignore must carry a one-line comment explaining why the type is wrong.

### Validation

- **Zod validation on every endpoint** (parse `req.body`, `req.query`, `req.params` at the route layer).
- Env vars validated at boot (see [apps/api/src/config.ts](apps/api/src/config.ts)).

### Logging

- Structured logging (pino) carrying `tenantId` and `requestId` on every line.
- Redaction is deny-by-default on credential-carrying paths (see [apps/api/src/logger.ts](apps/api/src/logger.ts)).

### The seven non-negotiable standards

These are from [CLAUDE.md](CLAUDE.md) and are checked at code review. Violating them is an architecture bug, not a style nit.

1. **Tenant scoping lives in ONE layer.** Never write `where: { tenantId }` manually in a service.
2. **Money is integer minor units.** `BigInt`/`Int` in Prisma, a `Money` helper in `packages/shared`. No `float` anywhere for money. Rounding happens exactly once, in the bill pipeline.
3. **Ledgers are append-only; balances are derived.** Stock, cash, and loyalty points are never `UPDATE`d. Insert a movement row; balance = `SUM(...)`. There is deliberately **no `stockOnHand` column**.
4. **Events go through a Transactional Outbox.** Business write + `OutboxEvent` row in the same DB transaction; an in-process worker dispatches. Consumers are idempotent on the event `id`.
5. **Feature toggles and permissions are guarded on both sides.** Frontend (`useFeature` / `usePermission`) is UX only; backend (`requireFeature` / `requirePermission`) is the security boundary. FE-only guarding is a bug.
6. **State machines are explicit.** Order, PurchaseOrder, Reservation, Shift transitions are validated in one place. An illegal transition throws.
7. **Snapshot at the right moment.** Item price/name freeze when an order hits `SENT`; PO price/qty freeze at `APPROVED`.

## Testing

### What requires tests

Anything touching **money, stock, or tenant scoping requires tests**. Specifically mandated integration tests:

- Cross-tenant isolation (proven at *both* the extension and RLS layers).
- Bill pipeline arithmetic across discount/service-charge/inclusive-exclusive-tax combinations.
- The split-bill sum invariant: `SUM(bill.total) === order total` after rounding.
- State machine legality (rejecting illegal transitions).

### Test stack

- Integration tests: `vitest` + `supertest` + real Postgres.
- E2E (Playwright): only for the critical happy path (order → pay → close shift).

### Test database

Two roles:
- `TEST_DATABASE_URL`: app role (NOBYPASSRLS, used by the extended client under test).
- `TEST_DIRECT_DATABASE_URL`: owner role (used to build fixtures and assert at the RLS layer).

Fixtures are built by the owner role with `set_config('app.current_tenant', ...)` so writes pass RLS `WITH CHECK`. Tests clean up their own data in `afterAll`.

### Every bug gets a reproducing test before the fix

A failed test that captures the bug proves the fix.

## Commands

```bash
# Install dependencies
pnpm install

# Development
pnpm dev                  # Start all apps + Postgres (Docker Compose)

# Build
pnpm run build            # Build all packages + apps
pnpm run typecheck        # TypeScript check all packages

# Lint & format
pnpm run lint             # ESLint all packages
pnpm run format           # Prettier all files

# Test
pnpm run test             # Run all test suites

# Database (from packages/db)
pnpm --filter @brewsync/db migrate       # Create a new migration (dev)
pnpm --filter @brewsync/db migrate:deploy # Apply migrations (CI/prod)
pnpm --filter @brewsync/db studio        # Open Prisma Studio
```

CI runs: `install → typecheck → lint → test → build`. All checks must pass before merge (enforced by branch protection).

## PR checklist

- [ ] Conventional Commit messages.
- [ ] TypeScript builds with no errors (`pnpm run typecheck`).
- [ ] ESLint passes (`pnpm run lint`).
- [ ] Tests pass (`pnpm run test`).
- [ ] If touching money/stock/tenant-scoping: integration test included.
- [ ] If adding a feature toggle or permission: guarded on both FE and BE.
- [ ] If modifying the bill pipeline or a state machine: existing tests still pass.
- [ ] PR under ~400 lines (split if larger).

## Questions?

Read [CLAUDE.md](CLAUDE.md) first — it contains the architecture decisions, domain model pointers, and sprint build order.
