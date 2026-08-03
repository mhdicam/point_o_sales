/**
 * S9-02 DoD — Landing CMS admin invariants that need a real database.
 *
 * These drive `LandingService` directly under a real tenant context (app role,
 * scoping live) — the state a unit test with a mocked client cannot reach:
 *   - lazy provisioning: the first `get()` mints ONE per-tenant DRAFT page with
 *     `slug = tenant.slug`; a second `get()` returns the same page, never a
 *     duplicate (the `@@unique([tenantId, slug])` index + P2002 re-read).
 *   - sections append at the tail (position = max+1) and reorder is a whole-list,
 *     two-phase transaction that never trips `@@unique([landingPageId, position])`.
 *   - reorder rejects a partial list or a non-contiguous position set before it
 *     writes anything.
 *   - publish/unpublish flip status + `publishedAt`; unpublishing a draft is a 409.
 *   - tenant scoping: a section id belonging to tenant A is invisible (404) under
 *     tenant B's context — the extension + RLS, not a hand-written tenant filter.
 *
 * Fixtures insert only the tenant rows (global, non-RLS) as the owner; every
 * landing read/write goes through the service under `runWithTenantContext`, so a
 * scoping regression fails here rather than being masked.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPrismaClient, runUnscoped, runWithTenantContext } from '@brewsync/db'
import { LandingService } from '../src/services/landing.service.js'

loadEnv({ path: resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const APP_ROLE_URL = process.env.TEST_DATABASE_URL!
const OWNER_ROLE_URL = withConnectionLimitOne(process.env.TEST_DIRECT_DATABASE_URL!)

function withConnectionLimitOne(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`
}

describe('S9-02 — landing CMS admin', () => {
  const dbApp = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  const dbOwner = createPrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  const svc = new LandingService(dbApp)

  const runId = randomUUID().slice(0, 8)
  let tenantA: string
  let slugA: string
  let tenantB: string

  const asA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenantId: tenantA }, async () => await fn())
  const asB = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenantId: tenantB }, async () => await fn())

  beforeAll(async () => {
    slugA = `cms-a-${runId}`
    await runUnscoped(async () => {
      const [a] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES (gen_random_uuid(), ${slugA}, 'CMS Tenant A', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
      tenantA = a!.id
      const [b] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES (gen_random_uuid(), ${`cms-b-${runId}`}, 'CMS Tenant B', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
      tenantB = b!.id
    })
  })

  afterAll(async () => {
    await runUnscoped(
      () => dbOwner.$executeRaw`DELETE FROM tenants WHERE id IN (${tenantA}::uuid, ${tenantB}::uuid)`
    )
    await dbApp.$disconnect()
    await dbOwner.$disconnect()
  })

  it('lazily provisions one DRAFT page with slug = tenant.slug, and is idempotent', async () => {
    const first = await asA(() => svc.get())
    expect(first.slug).toBe(slugA)
    expect(first.title).toBe('CMS Tenant A')
    expect(first.status).toBe('DRAFT')
    expect(first.publishedAt).toBeNull()
    expect(first.sections).toEqual([])

    // A second get() must return the same page, not mint a duplicate.
    const second = await asA(() => svc.get())
    expect(second.id).toBe(first.id)
  })

  it('appends sections at the tail (position = max + 1)', async () => {
    await asA(() => svc.addSection({ type: 'HERO', title: 'Welcome', content: {} }))
    await asA(() => svc.addSection({ type: 'ABOUT', title: 'About us', content: {} }))
    const page = await asA(() =>
      svc.addSection({ type: 'CONTACT', title: 'Reach us', content: {} })
    )

    expect(page.sections.map((s) => s.position)).toEqual([0, 1, 2])
    expect(page.sections.map((s) => s.type)).toEqual(['HERO', 'ABOUT', 'CONTACT'])
  })

  it('reorders the whole list in one pass without tripping the unique index', async () => {
    const before = await asA(() => svc.get())
    const [hero, about, contact] = before.sections
    // Reverse the order: contact, about, hero.
    const page = await asA(() =>
      svc.reorder([
        { id: contact!.id, position: 0 },
        { id: about!.id, position: 1 },
        { id: hero!.id, position: 2 },
      ])
    )
    expect(page.sections.map((s) => s.id)).toEqual([contact!.id, about!.id, hero!.id])
    expect(page.sections.map((s) => s.position)).toEqual([0, 1, 2])
  })

  it('rejects a reorder that omits a section', async () => {
    const page = await asA(() => svc.get())
    const [first] = page.sections
    await expect(
      asA(() => svc.reorder([{ id: first!.id, position: 0 }]))
    ).rejects.toThrow(/every section exactly once/i)
  })

  it('rejects a reorder with a non-contiguous position set', async () => {
    const page = await asA(() => svc.get())
    const gapped = page.sections.map((s, index) => ({ id: s.id, position: index * 2 }))
    await expect(asA(() => svc.reorder(gapped))).rejects.toThrow(/0\.\.n-1|gaps or repeats/i)
  })

  it('updates a section and removes it', async () => {
    const page = await asA(() => svc.get())
    const target = page.sections[0]!
    const updated = await asA(() =>
      svc.updateSection(target.id, { title: 'Renamed', isVisible: false })
    )
    const after = updated.sections.find((s) => s.id === target.id)!
    expect(after.title).toBe('Renamed')
    expect(after.isVisible).toBe(false)

    const removed = await asA(() => svc.removeSection(target.id))
    expect(removed.sections.some((s) => s.id === target.id)).toBe(false)
  })

  it('updates page meta and rejects a blank title', async () => {
    const page = await asA(() =>
      svc.updateMeta({ description: 'Kopi terbaik', orderingEnabled: true })
    )
    expect(page.description).toBe('Kopi terbaik')
    expect(page.orderingEnabled).toBe(true)
    // Slug stays pinned to the tenant slug regardless of meta edits.
    expect(page.slug).toBe(slugA)

    await expect(asA(() => svc.updateMeta({ title: '   ' }))).rejects.toThrow(/title is required/i)
  })

  it('publishes and unpublishes, and 409s an unpublish of a draft', async () => {
    const published = await asA(() => svc.publish())
    expect(published.status).toBe('PUBLISHED')
    expect(published.publishedAt).not.toBeNull()

    const draft = await asA(() => svc.unpublish())
    expect(draft.status).toBe('DRAFT')
    expect(draft.publishedAt).toBeNull()

    // Now it is a draft — a second unpublish is a 409.
    await expect(asA(() => svc.unpublish())).rejects.toMatchObject({
      status: 409,
      code: 'LANDING_NOT_PUBLISHED',
    })
  })

  it('scoping: a section id from tenant A is a 404 under tenant B', async () => {
    // Tenant A owns at least one section; tenant B provisions its own empty page.
    const pageA = await asA(() => svc.addSection({ type: 'GALLERY', content: {} }))
    const aSectionId = pageA.sections.at(-1)!.id

    await asB(() => svc.get())
    await expect(asB(() => svc.updateSection(aSectionId, { title: 'hijack' }))).rejects.toMatchObject(
      { status: 404, code: 'LANDING_SECTION_NOT_FOUND' }
    )
    await expect(asB(() => svc.getSectionType(aSectionId))).rejects.toMatchObject({ status: 404 })
  })
})
