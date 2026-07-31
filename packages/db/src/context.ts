/**
 * Request context — S1-02.
 *
 * Holds the current tenant (and outlet/user) for the lifetime of a request via
 * AsyncLocalStorage, so the Prisma extension can scope queries without every
 * service threading a tenantId parameter through its signature.
 *
 * AsyncLocalStorage rather than a module-level variable because Node serves
 * requests concurrently — a shared mutable global would leak tenant A's id into
 * tenant B's query under load, which is the exact failure this design prevents.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface TenantContext {
  tenantId: string
  /** Outlet in scope for this request, when the route is outlet-specific. */
  outletId?: string | undefined
  userId?: string | undefined
  requestId?: string | undefined
  /**
   * Internal: set once `app.current_tenant` is bound for the surrounding
   * transaction. The tenant-scope extension reads it to avoid opening a nested
   * transaction per operation when an outer `withTenantTransaction` already
   * bound the GUC. Not part of the public API — do not set it by hand.
   */
  readonly gucBound?: boolean | undefined
}

const storage = new AsyncLocalStorage<TenantContext>()

/** Run `fn` with `context` bound for its entire async subtree. */
export function runWithTenantContext<T>(context: TenantContext, fn: () => T): T {
  return storage.run(context, fn)
}

export const getTenantContext = (): TenantContext | undefined => storage.getStore()

export function requireTenantContext(): TenantContext {
  const context = storage.getStore()
  if (!context) {
    throw new MissingTenantContextError()
  }
  return context
}

/**
 * Escape hatch for genuinely cross-tenant work: platform admin queries, the
 * outbox worker sweeping all tenants, login (which resolves a user before any
 * tenant is known).
 *
 * Deliberately loud in name. Every call site is a place where the safety net is
 * off, so it should be greppable and rare.
 */
export function runUnscoped<T>(fn: () => T): T {
  return storage.run(UNSCOPED, fn)
}

const UNSCOPED_TENANT_ID = '__unscoped__'
const UNSCOPED: TenantContext = { tenantId: UNSCOPED_TENANT_ID }

export const isUnscoped = (context: TenantContext | undefined): boolean =>
  context?.tenantId === UNSCOPED_TENANT_ID

export class MissingTenantContextError extends Error {
  readonly code = 'MISSING_TENANT_CONTEXT'

  constructor() {
    super(
      'No tenant context bound for this operation. Wrap the call in ' +
        'runWithTenantContext(), or runUnscoped() if it is deliberately cross-tenant.'
    )
    this.name = 'MissingTenantContextError'
  }
}
