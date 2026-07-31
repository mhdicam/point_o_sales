/**
 * Prisma client factory — S1-03/S1-04 wiring.
 *
 * Two guards are composed here:
 *   1. tenant-scope extension — injects tenantId into queries.
 *   2. RLS — enforced by Postgres, needs `app.current_tenant` set on the
 *      connection.
 *
 * On (2): a pooled connection is shared, so the GUC must be scoped to the unit
 * of work rather than the session. `withTenantTransaction` opens a transaction,
 * issues `SET LOCAL app.current_tenant`, and runs the callback — the setting
 * reverts at commit/rollback and cannot leak to the next borrower.
 *
 * Plain `prisma.*` calls are still tenant-scoped by the extension. Use
 * `withTenantTransaction` for multi-statement work and anywhere RLS enforcement
 * must be provable (which is what the isolation tests assert).
 */

import { PrismaClient, type Prisma } from '../generated/client/index.js'
import { createTenantScopeExtension } from './tenant-scope.js'
import { requireTenantContext, runWithTenantContext, type TenantContext } from './context.js'

export type BrewsyncClient = ReturnType<typeof createPrismaClient>

export interface PrismaClientOptions {
  datasourceUrl?: string | undefined
  log?: ('query' | 'info' | 'warn' | 'error')[] | undefined
}

export function createPrismaClient(options: PrismaClientOptions = {}) {
  const base = new PrismaClient({
    ...(options.datasourceUrl ? { datasourceUrl: options.datasourceUrl } : {}),
    log: options.log ?? ['warn', 'error'],
  })

  return base.$extends(createTenantScopeExtension())
}

/**
 * Raw, unextended client. For migrations, seeds, and the outbox worker's
 * cross-tenant sweep. Named to make its use obvious in review.
 */
export function createUnscopedPrismaClient(options: PrismaClientOptions = {}) {
  return new PrismaClient({
    ...(options.datasourceUrl ? { datasourceUrl: options.datasourceUrl } : {}),
    log: options.log ?? ['warn', 'error'],
  })
}

/**
 * Run `fn` in a transaction with RLS active for the context's tenant.
 *
 * `SET LOCAL` keeps the GUC transaction-scoped. The tenant id is passed as a
 * bound parameter via set_config rather than interpolated, so a crafted id
 * cannot inject SQL.
 */
export async function withTenantTransaction<T>(
  client: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  context?: TenantContext
): Promise<T> {
  const ctx = context ?? requireTenantContext()

  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${ctx.tenantId}, true)`
    // gucBound tells the tenant-scope extension the GUC is already set for this
    // connection, so nested operations reuse this transaction instead of opening
    // one of their own per query.
    return runWithTenantContext({ ...ctx, gucBound: true }, () => fn(tx))
  })
}

/** Clear the tenant GUC — used by tests to prove RLS denies an unset tenant. */
export async function clearTenantGuc(client: PrismaClient): Promise<void> {
  await client.$executeRaw`SELECT set_config('app.current_tenant', '', false)`
}
