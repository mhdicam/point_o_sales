/**
 * Express app factory — S0-01 + S0-07 + S1-02/S1-05 + S2-04/S2-06/S2-07.
 *
 * Separated from index.ts so tests can mount the app with supertest without
 * binding a port or starting the outbox worker.
 *
 * Middleware order is load-bearing. Everything mounted before the tenant
 * middleware is reachable without a token, so adding a route above that line is
 * a security decision, not a formatting one.
 */

import express, { type Express } from 'express'
import pinoHttp from 'pino-http'
import type { Logger } from 'pino'
import type { BrewsyncClient } from '@brewsync/db'
import type { Config } from './config.js'
import { createAuthRouter, errorHandler } from './routes/auth.routes.js'
import { createHealthRouter } from './routes/health.routes.js'
import { createPinRouter } from './routes/pin.routes.js'
import { createMeRouter } from './routes/me.routes.js'
import { createSessionRouter } from './routes/session.routes.js'
import { createExampleRouter } from './routes/example.routes.js'
import { createRoleRouter } from './routes/role.routes.js'
import { createOnboardingRouter } from './routes/onboarding.routes.js'
import { createCategoryRouter } from './routes/category.routes.js'
import { createUnitRouter } from './routes/unit.routes.js'
import {
  createProductRouter,
  createVariantRouter,
  createImageRouter,
} from './routes/product.routes.js'
import { createModifierRouter, createProductModifierRouter } from './routes/modifier.routes.js'
import { createPriceRouter } from './routes/price.routes.js'
import { createOrderRouter } from './routes/order.routes.js'
import { createPaymentRouter } from './routes/payment.routes.js'
import { createShiftRouter } from './routes/shift.routes.js'
import { createSalesMethodRouter } from './routes/sales-method.routes.js'
import { createFloorPlanRouter } from './routes/floor-plan.routes.js'
import { createKdsRouter } from './routes/kds.routes.js'
import { createStockRouter } from './routes/stock.routes.js'
import { createRecipeRouter } from './routes/recipe.routes.js'
import { createSupplierRouter } from './routes/supplier.routes.js'
import { createPurchaseOrderRouter } from './routes/purchase-order.routes.js'
import { createReservationRouter } from './routes/reservation.routes.js'
import { createQrRouter } from './routes/qr.routes.js'
import { createPublicLandingRouter } from './routes/public-landing.routes.js'
import { createTenantMiddleware } from './middleware/tenant.middleware.js'

export function createApp(db: BrewsyncClient, config: Config, logger: Logger): Express {
  const app = express()

  // Structured request logging — every line carries requestId.
  app.use(pinoHttp({ logger }))

  app.use(express.json())

  // Money and unit factors are BigInt (standard #2), and JSON.stringify throws on
  // BigInt rather than guessing. Serialize as a decimal string — a JSON number
  // would silently lose precision past 2^53, which for money is a data bug.
  // Set once here so no route has to remember it.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value
  )

  // CORS — defaults to same-origin only (CORS_ORIGINS='').
  if (config.corsOrigins.length > 0) {
    app.use((_req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigins.join(','))
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      next()
    })
  }

  // ---- Public routes: no token required. ----

  // S0-07 — health check.
  app.use(createHealthRouter(db))

  // S1-05 — register/login/refresh/logout.
  app.use('/auth', createAuthRouter(db, config))

  // S2-06 — PIN login. Pre-tenant by necessity: a device at the login screen
  // holds no token, so this route binds its own context from provisioned ids.
  app.use('/pin', createPinRouter(db, config))

  // S2-08 — tenant onboarding. Pre-tenant by necessity: the tenant being created
  // does not exist yet, so there is no context to bind. Gated by an optional
  // platform token; when unset, the route is not mounted.
  const onboardingRouter = createOnboardingRouter(db, config)
  if (onboardingRouter) {
    app.use('/onboarding', onboardingRouter)
  }

  // S8-06 — QR self-service ordering. Pre-tenant by necessity: a customer
  // scanning a table QR holds no token. The router self-binds tenant/outlet
  // context from the resolved token (never client input) — the safest of the
  // pre-tenant routes. It carries its own per-IP rate limiter; `/pin` and future
  // `/online` ordering should adopt the same `createRateLimit` factory.
  app.use(createQrRouter(db))

  // S9-03 — public landing page (`/p/:slug`). Pre-tenant by necessity: a customer
  // opening a public catalog holds no token. The router self-binds tenant/outlet
  // context from the resolved PUBLISHED slug (never client input), gated on the
  // `landingPage` feature inside the service, and carries its own per-IP limiter.
  // The authenticated `/landing` CMS surface (S9-02) mounts after the tenant
  // middleware below.
  app.use(createPublicLandingRouter(db))

  // ---- Everything below requires a valid access token. ----

  // S1-02 — binds tenant context from the JWT for the Prisma extension.
  app.use(createTenantMiddleware(config))

  // S2-09 — tenant selection. Mounted here (token required) but deliberately
  // NOT behind requireTenant: an email/password session holds no tenant yet,
  // and this is the route that gives it one.
  app.use('/session', createSessionRouter(db, config))

  // S2-03/S2-05 — effective permissions, consumed by the FE usePermission hook.
  app.use('/me', createMeRouter(db))

  // S2-02 — role CRUD (system roles are immutable).
  app.use('/roles', createRoleRouter(db))

  // S3-01..S3-05 — product master foundations. Category, Unit, Product+Variant,
  // Modifier, and Price come before the bill pipeline (S4) consumes them.
  app.use('/categories', createCategoryRouter(db))
  app.use('/units', createUnitRouter(db))
  app.use('/products', createProductRouter(db))
  app.use('/variants', createVariantRouter(db))
  app.use('/images', createImageRouter(db))
  app.use('/modifiers', createModifierRouter(db))
  // Product-modifier attachment routes sit under /products for readability:
  // POST /products/:id/modifier-groups to attach, GET to list, DELETE to detach.
  app.use('/products', createProductModifierRouter(db))
  app.use('/prices', createPriceRouter(db))
  app.use('/orders', createOrderRouter(db))
  // S5-01..05 — bills, tenders, split, refund. Sits after /orders because it
  // settles orders the bill pipeline (S4) produced.
  app.use('/payments', createPaymentRouter(db))
  // S5-06/07 — shift open/close + cash drawer ledger.
  app.use('/shifts', createShiftRouter(db))
  // S7-01 — sales method config (dine-in / takeaway / delivery).
  app.use('/sales-methods', createSalesMethodRouter(db))
  // S7-02 — floor plan: areas + tables (gated on the `tables` feature).
  app.use('/floor-plan', createFloorPlanRouter(db))
  // S7-04 — stations + KDS board (gated on the `kds` feature).
  app.use('/', createKdsRouter(db))
  // S6-01 — stock ledger: on-hand, inventory-card history, stock-take adjust.
  app.use('/inventory', createStockRouter(db))
  // S6-03 — recipe / BOM per variant (gated on the `recipe` feature).
  app.use('/variants', createRecipeRouter(db))
  // S6-05 — supplier master (gated on the `purchasing` feature).
  app.use('/suppliers', createSupplierRouter(db))
  // S6-06 — purchase orders + state machine (gated on the `purchasing` feature).
  app.use('/purchase-orders', createPurchaseOrderRouter(db))
  // S8-01 — reservations + state machine (gated on the `reservation` feature).
  app.use('/reservations', createReservationRouter(db))

  // S2-04/S2-07 — reference wiring for the two guards. Real feature routes
  // replace this in S3+.
  app.use('/example', createExampleRouter(db))

  // Converts HttpError, ZodError and Prisma errors into the one error shape.
  app.use(errorHandler)

  return app
}
