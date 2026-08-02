/**
 * S6-05 DoD — supplier master invariants that fail *quietly* if they regress.
 *
 * Three behaviours the design (§4.4) pins down and nothing else guards:
 *   - `code` is unique per tenant. Postgres enforces the index; the service has
 *     to turn the P2002 into a clean 409 rather than a 500, or the editor shows
 *     an opaque error on a duplicate.
 *   - `code` is frozen after create. PO history looks a supplier up by it, so an
 *     edit that changed it would silently orphan past documents. `update` drops
 *     the field entirely (the type omits it); this proves a smuggled `code` in
 *     the payload is ignored, not applied.
 *   - a delete deactivates, never removes — a historical PO must keep resolving
 *     its vendor. `deactivate` flips `isActive` and the row stays fetchable.
 *
 * Everything runs under a real tenant context against the app role, so a
 * regression in tenant scoping fails here too rather than being masked.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPrismaClient, runUnscoped, runWithTenantContext } from '@brewsync/db'
import { SupplierService } from '../src/services/supplier.service.js'

loadEnv({ path: resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const APP_ROLE_URL = process.env.TEST_DATABASE_URL!
const OWNER_ROLE_URL = process.env.TEST_DIRECT_DATABASE_URL!

describe('S6-05 — supplier master', () => {
  const dbApp = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  const dbOwner = createPrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  const suppliers = new SupplierService(dbApp)

  const runId = randomUUID().slice(0, 8)
  let tenantId: string
  let seq = 0

  /**
   * The `await` inside is load-bearing: a Prisma delegate returns a lazy promise
   * that dispatches on `.then()`, so returning it unawaited lets the
   * async-local frame exit first and the extension sees no tenant at all.
   */
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenantId }, async () => await fn())

  /** Codes are unique per tenant, so every fixture gets its own counter suffix. */
  const nextCode = (): string => `SUP-${runId}-${++seq}`

  beforeAll(async () => {
    const rows = await runUnscoped(
      () => dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES (gen_random_uuid(), ${`sup-${runId}`}, 'Supplier Test', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
    )
    tenantId = rows[0]!.id
  })

  afterAll(async () => {
    await runUnscoped(() => dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`)
    await dbApp.$disconnect()
    await dbOwner.$disconnect()
  })

  it('creates a supplier and defaults the optional fields', async () => {
    const code = nextCode()
    const supplier = await asTenant(() => suppliers.create({ code, name: 'Acme Roasters' }))

    expect(supplier.code).toBe(code)
    expect(supplier.name).toBe('Acme Roasters')
    expect(supplier.isActive).toBe(true)
    expect(supplier.paymentTermDays).toBe(0)
    expect(supplier.defaultCurrency).toBe('IDR')
    expect(supplier.contactName).toBeNull()
  })

  it('rejects a duplicate code with a 409, not a 500', async () => {
    const code = nextCode()
    await asTenant(() => suppliers.create({ code, name: 'First' }))

    await expect(
      asTenant(() => suppliers.create({ code, name: 'Second' }))
    ).rejects.toThrow(/SUPPLIER_CODE_TAKEN|already in use/i)
  })

  it('freezes the code on update — a smuggled code is ignored', async () => {
    const code = nextCode()
    const supplier = await asTenant(() => suppliers.create({ code, name: 'Frozen' }))

    // `code` is omitted from UpdateSupplierInput; force one through anyway to
    // prove the service never writes it.
    const updated = await asTenant(() =>
      suppliers.update(supplier.id, { name: 'Renamed', code: 'HACKED' } as never)
    )

    expect(updated.code).toBe(code)
    expect(updated.name).toBe('Renamed')
  })

  it('deactivates rather than deletes — the row stays resolvable', async () => {
    const code = nextCode()
    const supplier = await asTenant(() => suppliers.create({ code, name: 'Retiring' }))

    const deactivated = await asTenant(() => suppliers.deactivate(supplier.id))
    expect(deactivated.isActive).toBe(false)

    // A historical PO must still be able to look the vendor up by id.
    const stillThere = await asTenant(() => suppliers.getById(supplier.id))
    expect(stillThere.id).toBe(supplier.id)
    expect(stillThere.code).toBe(code)
  })

  it('hides inactive suppliers from the default list but not from includeInactive', async () => {
    const supplier = await asTenant(() => suppliers.create({ code: nextCode(), name: 'Hidden' }))
    await asTenant(() => suppliers.deactivate(supplier.id))

    const active = await asTenant(() => suppliers.list())
    expect(active.some((s) => s.id === supplier.id)).toBe(false)

    const all = await asTenant(() => suppliers.list({ includeInactive: true }))
    expect(all.some((s) => s.id === supplier.id)).toBe(true)
  })

  it('rejects a negative payment term', async () => {
    await expect(
      asTenant(() => suppliers.create({ code: nextCode(), name: 'Bad Term', paymentTermDays: -1 }))
    ).rejects.toThrow(/cannot be negative/i)
  })
})
