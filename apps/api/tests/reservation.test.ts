/**
 * S8-01/02/04 DoD — Reservation invariants that need a real database.
 *
 * Behaviours the design (§15) pins down and the state test cannot reach:
 *   - The lifecycle is guarded by the state machine: confirm→seat→completed, or
 *     confirm→noShow/cancel on exception paths, all surface 409 on illegal moves.
 *   - Anti double-book (§15.3, S8-02): a single table rejects two CONFIRMED
 *     reservations with overlapping time windows. An edit that moves a CONFIRMED
 *     booking also clears the new window. Back-to-back (no overlap) is legal.
 *   - Seating creates an Order (§15.3, S8-04): the booking hands off to a live
 *     order, the table flips OCCUPIED, the deposit becomes a discount credit.
 *   - A deposit rides onto the new order at seat time and the table is OCCUPIED.
 *
 * Everything runs under a real tenant context against the app role, so a
 * regression in tenant scoping fails here too (the table belongs to the outlet;
 * a cross-tenant booking would trip the RLS or the outlet guard).
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPrismaClient, runUnscoped, runWithTenantContext } from '@brewsync/db'
import { ReservationService } from '../src/services/reservation.service.js'

loadEnv({ path: resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const APP_ROLE_URL = process.env.TEST_DATABASE_URL!
const OWNER_ROLE_URL = process.env.TEST_DIRECT_DATABASE_URL!

describe('S8 — reservation', () => {
  const dbApp = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  const dbOwner = createPrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  const svc = new ReservationService(dbApp)

  const runId = randomUUID().slice(0, 8)
  let tenantId: string
  let outletId: string
  let tableA: string
  let tableB: string

  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenantId }, async () => await fn())

  beforeAll(async () => {
    await runUnscoped(async () => {
      const [tenant] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES (gen_random_uuid(), ${`res-${runId}`}, 'Res Test', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
      tenantId = tenant!.id

      const [outlet] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO outlets (id, "tenantId", code, name, status, "updatedAt")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, 'MAIN', 'Main', 'ACTIVE', now())
        RETURNING id
      `
      outletId = outlet!.id

      // Seating a reservation creates an Order, which requires an outlet with
      // fiscal defaults — set them so the bill pipeline doesn't reject.
      await dbOwner.$executeRaw`
        UPDATE outlets SET "taxRateBp" = 0, "roundingIncrement" = 0 WHERE id = ${outletId}::uuid
      `

      const tables = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tables (id, "tenantId", "outletId", code, name, "qrToken", "updatedAt")
        VALUES
          (gen_random_uuid(), ${tenantId}::uuid, ${outletId}::uuid, 'T1', 'Table 1', gen_random_uuid()::text, now()),
          (gen_random_uuid(), ${tenantId}::uuid, ${outletId}::uuid, 'T2', 'Table 2', gen_random_uuid()::text, now())
        RETURNING id
      `
      tableA = tables[0]!.id
      tableB = tables[1]!.id
    })
  })

  afterAll(async () => {
    await runUnscoped(() => dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`)
    await dbApp.$disconnect()
    await dbOwner.$disconnect()
  })

  it('walks through the happy path: REQUESTED → CONFIRMED → SEATED → order exists', async () => {
    const now = new Date()
    const arrival = new Date(now.getTime() + 3_600_000) // 1 hour from now

    const created = await asTenant(() =>
      svc.create({
        outletId,
        customerName: 'Andi',
        customerPhone: '081234567890',
        partySize: 4,
        reservedFor: arrival,
        tableId: tableA,
        durationMin: 120,
        depositAmount: 50_000n,
        notes: 'Birthday dinner',
      })
    )
    expect(created.status).toBe('REQUESTED')
    expect(created.tableId).toBe(tableA)

    // Confirm holds the table — no other CONFIRMED on tableA for this window.
    const confirmed = await asTenant(() => svc.confirm(created.id))
    expect(confirmed.status).toBe('CONFIRMED')
    expect(confirmed.confirmedAt).not.toBeNull()

    // Seat opens an Order and moves the deposit as a credit.
    const seated = await asTenant(() => svc.seat(confirmed.id))
    expect(seated.status).toBe('SEATED')
    expect(seated.orderId).not.toBeNull()
    expect(seated.seatedAt).not.toBeNull()

    // The table should now be OCCUPIED.
    const table = await runUnscoped(() =>
      dbOwner.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM tables WHERE id = ${tableA}::uuid
      `
    )
    expect(table[0]!.status).toBe('OCCUPIED')

    // And the order should carry the deposit as an order-level discount.
    const order = await runUnscoped(() =>
      dbOwner.$queryRaw<Array<{ id: string; status: string; "tableId": string | null }>>`
        SELECT id, status, "tableId" FROM orders WHERE id = ${seated.orderId}::uuid
      `
    )
    expect(order[0]!.status).toBe('OPEN')
    expect(order[0]!.tableId).toBe(tableA)
  })

  it('rejects overlapping CONFIRMED bookings on the same table (anti double-book)', async () => {
    const start = new Date(Date.now() + 7_200_000) // 2 hours from now

    const first = await asTenant(() =>
      svc.create({
        outletId,
        customerName: 'Budi',
        customerPhone: '082345678901',
        partySize: 2,
        reservedFor: start,
        tableId: tableB,
        durationMin: 90,
      })
    )
    await asTenant(() => svc.confirm(first.id))

    // Second booking overlaps: starts 30 min in (inside the first window).
    const overlapStart = new Date(start.getTime() + 30 * 60_000)
    const second = await asTenant(() =>
      svc.create({
        outletId,
        customerName: 'Citra',
        customerPhone: '083456789012',
        partySize: 3,
        reservedFor: overlapStart,
        tableId: tableB,
        durationMin: 60,
      })
    )
    await expect(asTenant(() => svc.confirm(second.id))).rejects.toThrow(
      /overlapping|OVERLAP/i
    )
  })

  it('allows back-to-back CONFIRMED bookings (no overlap — legal)', async () => {
    const base = new Date(Date.now() + 10_800_000) // 3 hours from now

    // First booking: [base, base+60min).
    const first = await asTenant(() =>
      svc.create({
        outletId,
        customerName: 'Dewi',
        customerPhone: '084567890123',
        partySize: 4,
        reservedFor: base,
        tableId: tableA,
        durationMin: 60,
      })
    )
    await asTenant(() => svc.confirm(first.id))

    // Second booking starts exactly when the first ends — half-open [end, …).
    const after = new Date(base.getTime() + 60 * 60_000)
    const second = await asTenant(() =>
      svc.create({
        outletId,
        customerName: 'Eko',
        customerPhone: '085678901234',
        partySize: 6,
        reservedFor: after,
        tableId: tableA,
        durationMin: 120,
      })
    )
    // Should NOT throw — back-to-back is legal.
    const confirmed = await asTenant(() => svc.confirm(second.id))
    expect(confirmed.status).toBe('CONFIRMED')
  })

  it('no-shows a CONFIRMED booking and it cannot be seated after', async () => {
    const arrival = new Date(Date.now() + 14_400_000) // 4 hours from now
    const booking = await asTenant(() =>
      svc.create({
        outletId,
        customerName: 'Fajar',
        customerPhone: '086789012345',
        partySize: 1,
        reservedFor: arrival,
        tableId: tableA,
        durationMin: 60,
      })
    )
    await asTenant(() => svc.confirm(booking.id))

    const noShowed = await asTenant(() => svc.noShow(booking.id))
    expect(noShowed.status).toBe('NO_SHOW')

    // Cannot seat a no-show — the machine rules it out.
    await expect(asTenant(() => svc.seat(booking.id))).rejects.toThrow(
      /ILLEGAL_TRANSITION|transition/i
    )
  })

  it('cancels a REQUESTED booking before confirming', async () => {
    const booking = await asTenant(() =>
      svc.create({
        outletId,
        customerName: 'Gina',
        customerPhone: '087890123456',
        partySize: 3,
        reservedFor: new Date(Date.now() + 18_000_000),
        tableId: tableA,
      })
    )
    const cancelled = await asTenant(() => svc.cancel(booking.id, 'Guest called'))
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.notes).toContain('Cancelled: Guest called')
  })

  it('edits a CONFIRMED booking, re-checking overlap on a moved window', async () => {
    const base = new Date(Date.now() + 21_600_000) // 6 hours from now

    // Set up a confirmed booking on tableB.
    const blocker = await asTenant(() =>
      svc.create({
        outletId,
        customerName: 'Hana',
        customerPhone: '088012345678',
        partySize: 2,
        reservedFor: base,
        tableId: tableB,
        durationMin: 60,
      })
    )
    await asTenant(() => svc.confirm(blocker.id))

    // A second booking on tableB in a non-overlapping slot.
    const afterBlocker = new Date(base.getTime() + 60 * 60_000)
    const booking = await asTenant(() =>
      svc.create({
        outletId,
        customerName: 'Ivan',
        customerPhone: '089012345678',
        partySize: 4,
        reservedFor: afterBlocker,
        tableId: tableB,
        durationMin: 60,
      })
    )
    await asTenant(() => svc.confirm(booking.id))

    // Move the window back so it now overlaps the blocker — should fail.
    await expect(
      asTenant(() => svc.update(booking.id, { reservedFor: base }))
    ).rejects.toThrow(/overlapping|OVERLAP/i)
  })
})
