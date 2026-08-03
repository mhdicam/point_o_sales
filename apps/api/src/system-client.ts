/**
 * The one privileged (BYPASSRLS) Prisma client — the sanctioned cross-tenant /
 * pre-tenant read path.
 *
 * Why this exists (standard #1/#4): the app client (`createPrismaClient`) is
 * RLS-subject. `runUnscoped` on it only skips the tenant-scope extension's
 * injection — it does NOT bind `app.current_tenant` and does NOT bypass RLS, so
 * an unscoped read against a tenant table with no GUC bound returns ZERO rows.
 * That is correct for the app role. But the genuine pre-tenant reads — the public
 * landing slug resolve, the QR table resolve, the outbox worker's cross-tenant
 * sweep, the login membership list — have no tenant to bind yet and legitimately
 * span tenants. They run on THIS client, which connects as `brewsync_system`
 * (BYPASSRLS, SELECT-only), the one role Postgres exempts from RLS.
 *
 * There is no `runSystem` wrapper: this client carries no tenant-scope extension,
 * so a call needs no async-context frame — a plain `system.model.findX(...)` is
 * the whole thing. It is injected into the four services (and the outbox worker)
 * that own those reads, never reached through a global, so tests bind it to the
 * test database like any other dependency.
 */

import { createSystemPrismaClient, type PrismaClient } from '@brewsync/db'
import type { Config } from './config.js'

/** The BYPASSRLS client type. Named to make its privilege obvious at call sites. */
export type SystemClient = PrismaClient

/** Build the system client from config. One per process; injected, not global. */
export function createSystemClient(config: Config): SystemClient {
  return createSystemPrismaClient({
    datasourceUrl: config.UNSCOPED_DATABASE_URL,
    log: config.isProduction ? [] : ['error', 'warn'],
  })
}
