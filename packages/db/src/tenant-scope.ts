/**
 * Tenant-scoping Prisma Client Extension — S1-03, standard #1.
 *
 * Every query against a tenant-owned model gets `tenantId` injected from the
 * request context: filters on reads, values on writes. Services therefore never
 * write `where: { tenantId }` themselves — an ESLint rule rejects it, and the
 * review checklist treats it as an auto-reject (sprint plan §2.2).
 *
 * This is layer one. Postgres RLS (src/rls.ts) is layer two: if a query somehow
 * escapes this extension, the database still refuses to return another tenant's
 * rows. Two independent layers, because a single point of failure guarding
 * tenant isolation is not a safety property.
 *
 * The extension also binds `app.current_tenant`, which layer two reads. RLS is
 * FORCEd on every tenant table, so a query with no GUC bound returns zero rows
 * — meaning this binding is not optional bookkeeping, it is what makes ordinary
 * `prisma.outlet.findMany()` work at all.
 *
 * Why a transaction per operation: the GUC must be transaction-local. Setting it
 * at session level on a pooled connection is unsafe — another request can borrow
 * that connection between the SET and the query and inherit the wrong tenant.
 * `set_config(..., true)` reverts at commit, so a connection returned to the
 * pool carries nothing. Operations already inside `withTenantTransaction` skip
 * this and reuse the outer transaction (see `gucBound`).
 */

import { Prisma } from '../generated/client/index.js'
import { getTenantContext, isUnscoped, runWithTenantContext, MissingTenantContextError } from './context.js'

/**
 * Models carrying a tenantId column.
 *
 * Explicit allowlist rather than schema reflection: a new tenant-owned model
 * that someone forgets to add here fails loudly in the isolation test, which is
 * far better than silently opting out of scoping.
 */
export const TENANT_SCOPED_MODELS = new Set<string>([
  'Outlet',
  'BusinessProfile',
  'TenantMembership',
  'Role',
  'UserRole',
  'OutboxEvent',
  // Master product — S3
  'Unit',
  'Category',
  'Product',
  'ProductVariant',
  'ModifierGroup',
  'Modifier',
  'ProductModifierGroup',
  'PriceList',
  'PriceListItem',
])

/**
 * Global models with no tenantId, intentionally unscoped.
 *
 * - Tenant: the tenant row itself; scoping it would be circular.
 * - User / RefreshToken: global login identity (design §13) — a user exists
 *   across tenants; per-tenant data lives on TenantMembership.
 * - Permission / RolePermission: system catalog (design §12.2).
 * - ProcessedEvent: consumer idempotency bookkeeping.
 */
export const GLOBAL_MODELS = new Set<string>([
  'Tenant',
  'User',
  'RefreshToken',
  'Permission',
  'RolePermission',
  'ProcessedEvent',
])

/** Operations whose `args.where` must be narrowed to the tenant. */
const READ_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
])

/** Operations that both filter and must not be able to touch another tenant. */
const MUTATING_WHERE_OPS = new Set([
  'updateMany',
  'deleteMany',
])

/** Unique-target operations — see the comment in the handler for why these differ. */
const UNIQUE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
])

export function createTenantScopeExtension() {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'brewsync-tenant-scope',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!TENANT_SCOPED_MODELS.has(model)) {
              return await query(args)
            }

            const context = getTenantContext()

            if (!context) {
              throw new MissingTenantContextError()
            }

            // Deliberate cross-tenant work (outbox worker, platform admin).
            if (isUnscoped(context)) {
              return await query(args)
            }

            const { tenantId } = context
            const typedArgs = scopeArgs(operation, args as Record<string, unknown>, tenantId)

            // An outer withTenantTransaction already bound the GUC on this
            // connection; reuse it rather than nesting a transaction.
            if (context.gucBound) {
              return await query(typedArgs)
            }

            return await client.$transaction(async (tx) => {
              await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`

              // Re-dispatch on the transaction client rather than calling
              // query(): query() runs on a connection checked out separately
              // from `tx`, so it would not see the transaction-local GUC and
              // RLS would return zero rows. Verified experimentally — this is
              // the difference between the guard working and silently
              // returning nothing.
              const delegate = model.charAt(0).toLowerCase() + model.slice(1)
              const txDelegate = (tx as unknown as Record<string, Record<string, CallableFunction>>)[
                delegate
              ]

              return await runWithTenantContext({ ...context, gucBound: true }, async () =>
                txDelegate?.[operation]?.(typedArgs)
              )
            })
          },
        },
      },
    })
  )
}

/**
 * Applies the tenant filter/value appropriate to the operation.
 *
 * @internal Exported only so the S1-07 isolation suite can assert layer one on
 * its own. With RLS active, removing this injection would still return correct
 * rows, so an integration test cannot detect a layer-one regression — it has to
 * be checked directly.
 */
export function scopeArgs(
  operation: string,
  args: Record<string, unknown>,
  tenantId: string
): Record<string, unknown> {
  if (READ_OPS.has(operation) || MUTATING_WHERE_OPS.has(operation)) {
    args['where'] = mergeTenantFilter(args['where'], tenantId)
    return args
  }

  if (UNIQUE_OPS.has(operation)) {
    // findUnique/update/delete accept only unique fields in `where`, so a
    // tenantId cannot simply be merged in. RLS covers these: with the GUC bound,
    // Postgres returns no row for another tenant's id, so the result is the same
    // (null / RecordNotFound) without guessing at compound-key shapes.
    return args
  }

  if (operation === 'create') {
    args['data'] = withTenantId(args['data'], tenantId)
    return args
  }

  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    const data = args['data']
    args['data'] = Array.isArray(data)
      ? data.map((row) => withTenantId(row, tenantId))
      : withTenantId(data, tenantId)
    return args
  }

  if (operation === 'upsert') {
    args['create'] = withTenantId(args['create'], tenantId)
    return args
  }

  return args
}

function mergeTenantFilter(where: unknown, tenantId: string): Record<string, unknown> {
  if (where === null || where === undefined) {
    return { tenantId }
  }
  if (typeof where !== 'object') {
    return { tenantId }
  }
  // Overwrite rather than merge: a caller-supplied tenantId must never widen
  // the scope beyond the request's tenant.
  return { ...(where as Record<string, unknown>), tenantId }
}

function withTenantId(data: unknown, tenantId: string): Record<string, unknown> {
  if (data === null || data === undefined || typeof data !== 'object') {
    return { tenantId }
  }
  const record = data as Record<string, unknown>
  // A nested `tenant: { connect: … }` is the caller being explicit; leave it.
  if ('tenant' in record) return record
  return { ...record, tenantId }
}
