/**
 * S9-03 DoD — public landing page read, the parts that need a real database.
 *
 * The security AC (design §17.1) is that a public, unauthenticated request maps
 * to a tenant/outlet ONLY through the PUBLISHED slug — never client input, never
 * a draft. These tests drive `PublicLandingService` directly (no HTTP; the rate
 * limiter is a route concern) under the app role with scoping live, so a
 * regression in tenant scoping fails here too.
 *
 * Covered:
 *   - slug isolation: each tenant's slug resolves to its own tenant/page; a
 *     garbage slug is an opaque LANDING_INVALID (404).
 *   - publish opacity: DRAFT resolves to the same opaque 404 as a missing slug;
 *     unpublishing a live page 404s it.
 *   - feature gate: `landingPage` disabled → buildPage 404s opaquely even for a
 *     valid PUBLISHED slug.
 *   - catalog-from-master: a CATALOG section resolves its selection to live
 *     products with outlet-resolved prices; a deactivated product drops silently;
 *     non-catalog sections pass their content through untouched.
 *   - cross-tenant: each tenant's page catalog shows only that tenant's products —
 *     the GUC binding in buildPage is what keeps tenant A out of tenant B's page.
 *
 * Fixtures are written as the owner (RLS is FORCEd); the owner client is pinned
 * to one connection so the session GUC stays bound across inserts.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPrismaClient, runUnscoped } from '@brewsync/db'
import { PublicLandingService } from '../src/services/public-landing.service.js'

loadEnv({ path: resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const APP_ROLE_URL = process.env.TEST_DATABASE_URL!
const OWNER_ROLE_URL = withConnectionLimitOne(process.env.TEST_DIRECT_DATABASE_URL!)

function withConnectionLimitOne(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`
}

/** The landingPage feature toggle, on by default for the fixtures. */
const LANDING_FEATURES = { landingPage: true }

describe('S9-03 — public landing page read', () => {
  const dbApp = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  const dbOwner = createPrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  const landing = new PublicLandingService(dbApp)

  const runId = randomUUID().slice(0, 8)
  let tenantA: string
  let outletA: string
  let tenantB: string
  let outletB: string
  let slugA: string
  let slugB: string
  let slugDraft: string
  let variantA: string

  /** Sets the tenant's feature flags (owner). */
  async function setFeatures(tenantId: string, features: Record<string, boolean>): Promise<void> {
    await runUnscoped(
      () => dbOwner.$executeRaw`
        UPDATE business_profiles SET features = ${JSON.stringify(features)}::jsonb, "updatedAt" = now()
        WHERE "tenantId" = ${tenantId}::uuid
      `
    )
  }

  /** Flips a page's status (owner) — unpublish for the opacity test. */
  async function setPageStatus(pageSlug: string, status: 'DRAFT' | 'PUBLISHED'): Promise<void> {
    await runUnscoped(
      () => dbOwner.$executeRaw`
        UPDATE landing_pages SET status = ${status}, "publishedAt" = CASE WHEN ${status} = 'PUBLISHED' THEN now() ELSE NULL END
        WHERE slug = ${pageSlug}
      `
    )
  }

  beforeAll(async () => {
    await runUnscoped(async () => {
      // ---- Tenant A with a PUBLISHED page + a draft + a catalog + an inactive product.
      const [tenant] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES (gen_random_uuid(), ${`lp-a-${runId}`}, 'Landing A', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
      tenantA = tenant!.id
      await dbOwner.$executeRaw`
        INSERT INTO business_profiles (id, "tenantId", preset, features, "updatedAt")
        VALUES (gen_random_uuid(), ${tenantA}::uuid, 'FNB', ${JSON.stringify(LANDING_FEATURES)}::jsonb, now())
      `
      const [outlet] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO outlets (id, "tenantId", code, name, status, "taxRateBp", "roundingIncrement", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantA}::uuid, 'OUTA', 'Outlet A', 'ACTIVE', 0, 0, now())
        RETURNING id
      `
      outletA = outlet!.id

      const [prod] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO products (id, "tenantId", name, slug, "updatedAt")
        VALUES (gen_random_uuid(), ${tenantA}::uuid, 'Kopi A', ${`a-prod-${runId}`}, now())
        RETURNING id
      `
      const [variant] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO product_variants (id, "tenantId", "productId", sku, name, "basePrice", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantA}::uuid, ${prod!.id}::uuid, ${`SKU-A-${runId}`}, 'Kopi A', 15000, now())
        RETURNING id
      `
      variantA = variant!.id

      // A deactivated product must silently drop from the catalog.
      await dbOwner.$executeRaw`
        INSERT INTO products (id, "tenantId", name, slug, "isActive", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantA}::uuid, 'Hidden A', ${`a-hidden-${runId}`}, false, now())
      `

      slugA = `landing-a-${runId}`
      slugDraft = `landing-draft-${runId}`
      await dbOwner.$queryRaw`
        INSERT INTO landing_pages (id, "tenantId", "outletId", slug, title, description, theme, "orderingEnabled", status, "publishedAt", "updatedAt")
        VALUES
          (gen_random_uuid(), ${tenantA}::uuid, ${outletA}::uuid, ${slugA}, 'Outlet A Landing', 'Best kopi in town', ${JSON.stringify({ brand: '#123456' })}::jsonb, false, 'PUBLISHED', now(), now()),
          (gen_random_uuid(), ${tenantA}::uuid, ${outletA}::uuid, ${slugDraft}, 'Draft Page', NULL, NULL, false, 'DRAFT', NULL, now())
      `
      await dbOwner.$executeRaw`
        INSERT INTO landing_sections (id, "tenantId", "landingPageId", type, position, title, content)
        SELECT gen_random_uuid(), ${tenantA}::uuid, lp.id, 'CATALOG', 0, 'Menu', '{}'::jsonb
        FROM landing_pages lp WHERE lp."tenantId" = ${tenantA}::uuid AND lp.slug = ${slugA}
      `
      await dbOwner.$executeRaw`
        INSERT INTO landing_sections (id, "tenantId", "landingPageId", type, position, title, content)
        SELECT gen_random_uuid(), ${tenantA}::uuid, lp.id, 'HOURS', 1, 'Hours', ${JSON.stringify({ hours: '09:00-22:00' })}::jsonb
        FROM landing_pages lp WHERE lp."tenantId" = ${tenantA}::uuid AND lp.slug = ${slugA}
      `

      // ---- Tenant B with its OWN published page + product, to prove isolation.
      const [tenantBRow] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES (gen_random_uuid(), ${`lp-b-${runId}`}, 'Landing B', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
      tenantB = tenantBRow!.id
      await dbOwner.$executeRaw`
        INSERT INTO business_profiles (id, "tenantId", preset, features, "updatedAt")
        VALUES (gen_random_uuid(), ${tenantB}::uuid, 'FNB', ${JSON.stringify(LANDING_FEATURES)}::jsonb, now())
      `
      const [outletBRow] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO outlets (id, "tenantId", code, name, status, "taxRateBp", "roundingIncrement", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantB}::uuid, 'OUTB', 'Outlet B', 'ACTIVE', 0, 0, now())
        RETURNING id
      `
      outletB = outletBRow!.id
      const [prodB] = await dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO products (id, "tenantId", name, slug, "updatedAt")
        VALUES (gen_random_uuid(), ${tenantB}::uuid, 'Kopi B', ${`b-prod-${runId}`}, now())
        RETURNING id
      `
      // Kopi B's variant makes it purchasable so it appears in the catalog.
      await dbOwner.$executeRaw`
        INSERT INTO product_variants (id, "tenantId", "productId", sku, name, "basePrice", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantB}::uuid, ${prodB!.id}::uuid, ${`SKU-B-${runId}`}, 'Kopi B', 20000, now())
      `

      slugB = `landing-b-${runId}`
      await dbOwner.$queryRaw`
        INSERT INTO landing_pages (id, "tenantId", "outletId", slug, title, description, theme, "orderingEnabled", status, "publishedAt", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantB}::uuid, ${outletB}::uuid, ${slugB}, 'Outlet B Landing', NULL, NULL, false, 'PUBLISHED', now(), now())
      `
      await dbOwner.$executeRaw`
        INSERT INTO landing_sections (id, "tenantId", "landingPageId", type, position, title, content)
        SELECT gen_random_uuid(), ${tenantB}::uuid, lp.id, 'CATALOG', 0, 'Menu', '{}'::jsonb
        FROM landing_pages lp WHERE lp."tenantId" = ${tenantB}::uuid AND lp.slug = ${slugB}
      `
    })
  })

  afterAll(async () => {
    await runUnscoped(() =>
      dbOwner.$executeRaw`DELETE FROM tenants WHERE id IN (${tenantA}::uuid, ${tenantB}::uuid)`
    )
    await dbApp.$disconnect()
    await dbOwner.$disconnect()
  })

  it('resolves each tenant slug to its own tenant and rejects a garbage slug opaquely', async () => {
    const resolvedA = await landing.resolveSlug(slugA)
    expect(resolvedA.tenantId).toBe(tenantA)
    expect(resolvedA.outletId).toBe(outletA)

    const resolvedB = await landing.resolveSlug(slugB)
    expect(resolvedB.tenantId).toBe(tenantB)
    expect(resolvedB.outletId).toBe(outletB)

    await expect(landing.resolveSlug('not-a-real-slug')).rejects.toMatchObject({
      status: 404,
      code: 'LANDING_INVALID',
    })
  })

  it('publish opacity: a DRAFT slug is the same opaque 404 as a missing slug', async () => {
    await expect(landing.resolveSlug(slugDraft)).rejects.toMatchObject({
      status: 404,
      code: 'LANDING_INVALID',
    })
  })

  it('unpublishing a live page 404s it', async () => {
    await setPageStatus(slugA, 'DRAFT')
    await expect(landing.resolveSlug(slugA)).rejects.toMatchObject({
      status: 404,
      code: 'LANDING_INVALID',
    })
    await setPageStatus(slugA, 'PUBLISHED')
    await expect(landing.resolveSlug(slugA)).resolves.toMatchObject({ tenantId: tenantA })
  })

  it('builds the page: meta, outlet name, sections in position order', async () => {
    const resolved = await landing.resolveSlug(slugA)
    const page = await landing.buildPage(resolved)

    expect(page.page.title).toBe('Outlet A Landing')
    expect(page.page.slug).toBe(slugA)
    expect(page.page.orderingEnabled).toBe(false)
    expect(page.page.theme).toEqual({ brand: '#123456' })
    expect(page.outlet).toEqual({ name: 'Outlet A' })

    // Position order: CATALOG (0) then HOURS (1).
    expect(page.sections.map((s) => s.type)).toEqual(['CATALOG', 'HOURS'])
  })

  it('catalog resolves live products with outlet-resolved prices; hidden ones drop', async () => {
    const resolved = await landing.resolveSlug(slugA)
    const page = await landing.buildPage(resolved)

    const catalog = page.sections.find((s) => s.type === 'CATALOG')
    expect(catalog).toBeDefined()

    // Live master pull: Kopi A appears with its variant and price as string.
    const product = (catalog as { catalog: Array<{ name: string; variants: Array<{ variantId: string; price: string }> }> }).catalog.find(
      (p) => p.name === 'Kopi A'
    )
    expect(product).toBeDefined()
    expect(product!.variants[0]!.variantId).toBe(variantA)
    expect(product!.variants[0]!.price).toBe('15000')

    // The deactivated product silently dropped (opaque, like QR).
    const names = (catalog as { catalog: Array<{ name: string }> }).catalog.map((p) => p.name)
    expect(names).toContain('Kopi A')
    expect(names).not.toContain('Hidden A')
  })

  it('non-catalog sections pass their content through untouched', async () => {
    const resolved = await landing.resolveSlug(slugA)
    const page = await landing.buildPage(resolved)

    const hours = page.sections.find((s) => s.type === 'HOURS')
    expect(hours!.content).toEqual({ hours: '09:00-22:00' })
    expect(hours).not.toHaveProperty('catalog')
  })

  it('cross-tenant: each page catalog shows only its own tenant products', async () => {
    // If the GUC binding in buildPage were wrong, tenant A's page would leak
    // tenant B's products (or vice versa). Both share an identical slug pattern
    // and both are PUBLISHED, so the only thing separating them is the bound
    // tenant context — exactly what this asserts.
    const pageA = await landing.buildPage(await landing.resolveSlug(slugA))
    const pageB = await landing.buildPage(await landing.resolveSlug(slugB))

    const namesOf = (page: typeof pageA) =>
      page.sections
        .filter((s) => s.type === 'CATALOG')
        .flatMap((s) => (s as { catalog: Array<{ name: string }> }).catalog.map((p) => p.name))

    expect(namesOf(pageA)).toEqual(['Kopi A'])
    expect(namesOf(pageB)).toEqual(['Kopi B'])
  })

  it('feature off: landingPage disabled masks a valid PUBLISHED slug as LANDING_INVALID', async () => {
    await setFeatures(tenantA, { landingPage: false })
    const resolved = await landing.resolveSlug(slugA)
    await expect(landing.buildPage(resolved)).rejects.toMatchObject({
      status: 404,
      code: 'LANDING_INVALID',
    })
    await setFeatures(tenantA, LANDING_FEATURES)
  })
})
