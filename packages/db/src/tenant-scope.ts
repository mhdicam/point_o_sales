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
  'ProductImage',
  'ProductVariant',
  'ModifierGroup',
  'Modifier',
  'ProductModifierGroup',
  'PriceList',
  'PriceListItem',
  // Order — S4
  'Order',
  'OrderItem',
  'OrderCharge',
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
            const typedArgs = scopeArgs(operation, args as Record<string, unknown>, tenantId, model)

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
 * Writes recurse. Prisma lets a single `create` build a whole subtree
 * (`product.create({ data: { …, variants: { create: [...] } } })`), and every
 * row in that subtree needs its own `tenantId`. Injecting only at the top level
 * left the nested rows without one, and because their generated types require
 * the `tenant` relation, Prisma rejected the whole call with "Argument `tenant`
 * is missing." before any SQL ran — so nested creates never worked at all. The
 * alternative (services passing `tenantId` by hand into nested rows) is exactly
 * what standard #1 forbids.
 *
 * @internal Exported only so the S1-07 isolation suite can assert layer one on
 * its own. With RLS active, removing this injection would still return correct
 * rows, so an integration test cannot detect a layer-one regression — it has to
 * be checked directly.
 */
export function scopeArgs(
  operation: string,
  args: Record<string, unknown>,
  tenantId: string,
  model: string
): Record<string, unknown> {
  if (READ_OPS.has(operation) || MUTATING_WHERE_OPS.has(operation)) {
    args['where'] = mergeTenantFilter(args['where'], tenantId)
    // updateMany/deleteMany take scalar-only `data`; no subtree to walk.
    return args
  }

  if (operation === 'create') {
    args['data'] = scopeWriteData(model, args['data'], tenantId, true)
    return args
  }

  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    args['data'] = mapEach(args['data'], (row) => scopeWriteData(model, row, tenantId, true))
    return args
  }

  if (operation === 'upsert') {
    args['create'] = scopeWriteData(model, args['create'], tenantId, true)
    if ('update' in args) {
      args['update'] = scopeWriteData(model, args['update'], tenantId, false)
    }
    return args
  }

  if (UNIQUE_OPS.has(operation)) {
    // findUnique/update/delete accept only unique fields in `where`, so a
    // tenantId cannot simply be merged in. RLS covers these: with the GUC bound,
    // Postgres returns no row for another tenant's id, so the result is the same
    // (null / RecordNotFound) without guessing at compound-key shapes.
    //
    // `update` still needs its data walked — the row itself keeps the tenantId
    // it was created with, but a nested `create` underneath it is a new row.
    if ('data' in args) {
      args['data'] = scopeWriteData(model, args['data'], tenantId, false)
    }
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

/**
 * relation field → target model, per model, from the generated data model.
 *
 * Derived rather than hand-listed: the walker has to know whether `images` on
 * Product points at a tenant-scoped model or a global one, and a hand-kept map
 * would drift the first time someone adds a relation.
 */
let relationsByModel: Map<string, Map<string, string>> | null = null

function relationsOf(model: string): Map<string, string> {
  if (!relationsByModel) {
    relationsByModel = new Map()
    for (const entry of Prisma.dmmf.datamodel.models) {
      const relations = new Map<string, string>()
      for (const field of entry.fields) {
        if (field.kind === 'object') {
          relations.set(field.name, field.type)
        }
      }
      relationsByModel.set(entry.name, relations)
    }
  }
  return relationsByModel.get(model) ?? new Map()
}

/**
 * Injects tenantId into a write payload and into every tenant-scoped row nested
 * beneath it.
 *
 * `injectSelf` is false when the payload updates an existing row: that row
 * already carries its tenantId, and writing it again would let a caller move a
 * row between tenants. Its nested creates are still walked.
 */
function scopeWriteData(
  model: string,
  data: unknown,
  tenantId: string,
  injectSelf: boolean
): unknown {
  if (!isRecord(data)) {
    return injectSelf ? { tenantId } : data
  }

  const out: Record<string, unknown> = { ...data }
  const relations = relationsOf(model)

  for (const key of Object.keys(out)) {
    const target = relations.get(key)
    if (target === undefined || !TENANT_SCOPED_MODELS.has(target)) continue
    if (!isRecord(out[key])) continue
    out[key] = scopeNestedWrite(target, out[key] as Record<string, unknown>, tenantId)
  }

  if (injectSelf && !('tenant' in out)) {
    // A nested `tenant: { connect: … }` is the caller being explicit; leave it.
    out['tenantId'] = tenantId
  }

  return out
}

/**
 * Walks one nested-relation payload, e.g. the `{ create: [...] }` under
 * `variants`.
 *
 * `connect` / `disconnect` / `set` are deliberately untouched: they reference
 * rows that already exist, and RLS `USING` is what stops a cross-tenant id
 * there. Only the verbs that produce or modify rows are rewritten.
 */
function scopeNestedWrite(
  target: string,
  nested: Record<string, unknown>,
  tenantId: string
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...nested }

  if ('create' in out) {
    out['create'] = mapEach(out['create'], (row) => scopeWriteData(target, row, tenantId, true))
  }

  if (isRecord(out['createMany'])) {
    const createMany: Record<string, unknown> = { ...out['createMany'] }
    createMany['data'] = mapEach(createMany['data'], (row) =>
      scopeWriteData(target, row, tenantId, true)
    )
    out['createMany'] = createMany
  }

  if ('connectOrCreate' in out) {
    out['connectOrCreate'] = mapEach(out['connectOrCreate'], (entry) =>
      rewriteBranches(target, entry, tenantId, ['create'])
    )
  }

  if ('upsert' in out) {
    out['upsert'] = mapEach(out['upsert'], (entry) =>
      rewriteBranches(target, entry, tenantId, ['create', 'update'])
    )
  }

  if ('update' in out) {
    out['update'] = mapEach(out['update'], (entry) => {
      // To-many form is { where, data }; to-one form is the data itself.
      if (isRecord(entry) && 'data' in entry) {
        return rewriteBranches(target, entry, tenantId, ['data'])
      }
      return scopeWriteData(target, entry, tenantId, false)
    })
  }

  // updateMany's `data` is scalar-only, so there is nothing nested to reach.

  return out
}

/** Rewrites named sub-payloads of one entry; `create` injects, the rest do not. */
function rewriteBranches(
  target: string,
  entry: unknown,
  tenantId: string,
  branches: readonly string[]
): unknown {
  if (!isRecord(entry)) return entry

  const out: Record<string, unknown> = { ...entry }
  for (const branch of branches) {
    if (!(branch in out)) continue
    out[branch] = mapEach(out[branch], (row) =>
      scopeWriteData(target, row, tenantId, branch === 'create')
    )
  }
  return out
}

/** Applies `fn` to a payload that Prisma accepts as either one object or a list. */
function mapEach(value: unknown, fn: (row: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map((row) => fn(row)) : fn(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
