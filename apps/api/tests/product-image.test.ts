/**
 * S3-03 — ProductImage: the cover invariant, and tenant scoping of a nested write.
 *
 * Two things are under test here, and they are related by history.
 *
 * 1. "Images exist ⇒ exactly one of them is the cover." The design doc is silent
 *    on image modelling, so this is our reading (see the schema comment on
 *    ProductImage): an explicit `isCover` column, not "row 0 is the cover".
 *    Postgres makes no promise about insertion order, and a product whose grid
 *    card renders blank is a visible bug. Prisma cannot express a partial unique
 *    index, so the invariant lives in ProductService and this file is what holds
 *    it — there is no database constraint behind it.
 *
 * 2. `ProductService.create` builds the whole subtree in one nested write. That
 *    call was completely broken — Prisma rejected it with "Argument `tenant` is
 *    missing." because the tenant-scope extension only stamped top-level `data`
 *    — and the suite stayed green, because nothing exercised it. So these tests
 *    run through the real service under a real tenant context, with no manual
 *    tenantId anywhere (standard #1). If nested scoping regresses, the very first
 *    test fails.
 *
 * The isolation block at the end is narrower than
 * packages/db/tests/tenant-isolation.test.ts and does not replace it: that file
 * proves both layers independently. Here we only assert that product_images
 * behaves like every other tenant table, since it is the newest one and the
 * easiest to forget in TENANT_SCOPED_MODELS / RLS_TABLES.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPrismaClient, runUnscoped, runWithTenantContext } from '@brewsync/db'
import { ProductService } from '../src/services/product.service.js'

loadEnv({ path: resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const APP_ROLE_URL = process.env.TEST_DATABASE_URL!
const OWNER_ROLE_URL = process.env.TEST_DIRECT_DATABASE_URL!

interface ImageRow {
  id: string
  url: string
  isCover: boolean
  sortOrder: number
}

describe('S3-03 — product images', () => {
  const dbApp = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  const dbOwner = createPrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  const products = new ProductService(dbApp)

  const runId = randomUUID().slice(0, 8)
  let tenantId: string
  let otherTenantId: string
  let productSeq = 0

  /**
   * Runs in the tenant's context, the way a request would.
   *
   * The `await` inside matters: a Prisma delegate returns a lazy promise that
   * dispatches on `.then()`, so handing it back unawaited lets the async-local
   * frame exit first and the extension then sees no context at all. Awaiting here
   * keeps the dispatch inside the frame.
   */
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenantId }, async () => await fn())

  const asOtherTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenantContext({ tenantId: otherTenantId }, async () => await fn())

  /**
   * Fixtures go through the service, not raw SQL. That is deliberate: the nested
   * create is itself part of what regressed, so building fixtures any other way
   * would hide the bug this file exists to catch.
   */
  async function createProduct(
    images: Array<{ url: string; isCover?: boolean; sortOrder?: number }> = [],
    run: <T>(fn: () => Promise<T>) => Promise<T> = asTenant
  ) {
    const n = ++productSeq
    return await run(async () =>
      products.create({
        name: `Fixture ${n}`,
        slug: `fixture-${runId}-${n}`,
        variants: [{ sku: `SKU-${runId}-${n}`, name: 'Default', basePrice: 15_000n }],
        images,
      })
    )
  }

  const url = (tag: string) => `https://cdn.example.com/${runId}/${tag}.jpg`

  beforeAll(async () => {
    const rows = await runUnscoped(
      () => dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES
          (gen_random_uuid(), ${`img-a-${runId}`}, 'Image Test A', 'ACTIVE', 'Asia/Jakarta', 'IDR', now()),
          (gen_random_uuid(), ${`img-b-${runId}`}, 'Image Test B', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
    )
    tenantId = rows[0]!.id
    otherTenantId = rows[1]!.id
  })

  afterAll(async () => {
    await runUnscoped(
      () => dbOwner.$executeRaw`
        DELETE FROM tenants WHERE id IN (${tenantId}::uuid, ${otherTenantId}::uuid)
      `
    )
    await dbApp.$disconnect()
    await dbOwner.$disconnect()
  })

  describe('create — nested write', () => {
    it('creates a product with variants and images in one call', async () => {
      // The regression test. Before the extension walked nested writes, this
      // threw "Argument `tenant` is missing." and no product could be created.
      const product = await createProduct([{ url: url('a') }, { url: url('b') }])

      expect(product.variants).toHaveLength(1)
      expect(product.images).toHaveLength(2)
      // Stamped by the extension — the service passes no tenantId of its own.
      for (const image of product.images) {
        expect(image.tenantId).toBe(tenantId)
      }
      expect(product.variants[0]!.tenantId).toBe(tenantId)
    })

    it('makes the first image the cover when none is marked', async () => {
      const product = await createProduct([{ url: url('first') }, { url: url('second') }])

      const covers = product.images.filter((i) => i.isCover)
      expect(covers).toHaveLength(1)
      expect(covers[0]!.url).toBe(url('first'))
    })

    it('honours an explicitly marked cover', async () => {
      const product = await createProduct([
        { url: url('plain') },
        { url: url('hero'), isCover: true },
      ])

      const cover = product.images.find((i) => i.isCover)
      expect(cover?.url).toBe(url('hero'))
    })

    it('returns the cover first', async () => {
      const product = await createProduct([
        { url: url('ord-1') },
        { url: url('ord-2'), isCover: true },
      ])

      expect(product.images[0]!.url).toBe(url('ord-2'))
    })

    it('rejects two covers rather than picking one', async () => {
      await expect(
        createProduct([
          { url: url('dup-1'), isCover: true },
          { url: url('dup-2'), isCover: true },
        ])
      ).rejects.toThrow(/MULTIPLE_COVERS|one image/i)
    })

    it('allows a product with no images', async () => {
      const product = await createProduct([])
      expect(product.images).toEqual([])
    })
  })

  describe('addImage', () => {
    it('the first image added becomes the cover', async () => {
      const product = await createProduct([])

      const image = await asTenant(() => products.addImage(product.id, { url: url('lone') }))

      // isCover: false was never asked for, but a product cannot hold images and
      // no cover — the service overrides the default.
      expect(image.isCover).toBe(true)
    })

    it('a later image does not steal the cover', async () => {
      const product = await createProduct([{ url: url('kept') }])

      const added = await asTenant(() => products.addImage(product.id, { url: url('added') }))

      expect(added.isCover).toBe(false)
      const list = await asTenant(() => products.listImages(product.id))
      expect(list.filter((i) => i.isCover).map((i) => i.url)).toEqual([url('kept')])
    })

    it('adding with isCover demotes the incumbent', async () => {
      const product = await createProduct([{ url: url('old-cover') }])

      await asTenant(() => products.addImage(product.id, { url: url('new-cover'), isCover: true }))

      const list = await asTenant(() => products.listImages(product.id))
      expect(list.filter((i) => i.isCover).map((i) => i.url)).toEqual([url('new-cover')])
    })

    it('appends rather than colliding on sortOrder 0', async () => {
      const product = await createProduct([{ url: url('s0') }])

      const second = await asTenant(() => products.addImage(product.id, { url: url('s1') }))
      const third = await asTenant(() => products.addImage(product.id, { url: url('s2') }))

      expect(second.sortOrder).toBe(1)
      expect(third.sortOrder).toBe(2)
    })

    it('throws PRODUCT_NOT_FOUND for an unknown product', async () => {
      await expect(
        asTenant(() => products.addImage(randomUUID(), { url: url('orphan') }))
      ).rejects.toThrow(/not found/i)
    })
  })

  describe('updateImage', () => {
    it('promoting an image demotes the current cover', async () => {
      const product = await createProduct([{ url: url('p-a') }, { url: url('p-b') }])
      const target = product.images.find((i) => !i.isCover)!

      await asTenant(() => products.updateImage(target.id, { isCover: true }))

      const list = await asTenant(() => products.listImages(product.id))
      expect(list.filter((i) => i.isCover).map((i) => i.url)).toEqual([target.url])
    })

    it('refuses to demote the only cover', async () => {
      // Refused rather than silently accepted: the alternative is a product with
      // images and no cover, which is the state the invariant exists to prevent.
      const product = await createProduct([{ url: url('solo') }])
      const cover = product.images[0]!

      await expect(
        asTenant(() => products.updateImage(cover.id, { isCover: false }))
      ).rejects.toThrow(/CANNOT_UNSET_COVER|without setting another/i)
    })

    it('updates url and alt without touching cover state', async () => {
      const product = await createProduct([{ url: url('meta') }])
      const image = product.images[0]!

      const updated = await asTenant(() =>
        products.updateImage(image.id, { url: url('meta-2'), alt: 'Kopi susu gula aren' })
      )

      expect(updated.url).toBe(url('meta-2'))
      expect(updated.alt).toBe('Kopi susu gula aren')
      expect(updated.isCover).toBe(true)
    })

    it('throws IMAGE_NOT_FOUND for an unknown image', async () => {
      await expect(
        asTenant(() => products.updateImage(randomUUID(), { alt: 'x' }))
      ).rejects.toThrow(/not found/i)
    })
  })

  describe('deleteImage', () => {
    it('deleting the cover promotes the next in display order', async () => {
      const product = await createProduct([
        { url: url('d-1'), sortOrder: 0 },
        { url: url('d-2'), sortOrder: 1 },
        { url: url('d-3'), sortOrder: 2 },
      ])
      const cover = product.images.find((i) => i.isCover)!
      expect(cover.url).toBe(url('d-1'))

      await asTenant(() => products.deleteImage(cover.id))

      const list = await asTenant(() => products.listImages(product.id))
      expect(list.filter((i) => i.isCover).map((i) => i.url)).toEqual([url('d-2')])
    })

    it('deleting a non-cover leaves the cover alone', async () => {
      const product = await createProduct([{ url: url('k-1') }, { url: url('k-2') }])
      const other = product.images.find((i) => !i.isCover)!

      await asTenant(() => products.deleteImage(other.id))

      const list = await asTenant(() => products.listImages(product.id))
      expect(list.map((i) => i.url)).toEqual([url('k-1')])
      expect(list[0]!.isCover).toBe(true)
    })

    it('deleting the last image leaves the product with none', async () => {
      // No minimum, unlike variants: a product with no image is legitimate.
      const product = await createProduct([{ url: url('last') }])

      await asTenant(() => products.deleteImage(product.images[0]!.id))

      expect(await asTenant(() => products.listImages(product.id))).toEqual([])
    })

    it('returns false for an unknown image rather than throwing', async () => {
      expect(await asTenant(() => products.deleteImage(randomUUID()))).toBe(false)
    })
  })

  describe('reorderImages', () => {
    it('rewrites sortOrder to match the given list', async () => {
      const product = await createProduct([
        { url: url('r-1') },
        { url: url('r-2') },
        { url: url('r-3') },
      ])
      const byUrl = new Map(product.images.map((i) => [i.url, i.id]))

      const reordered: ImageRow[] = await asTenant(() =>
        products.reorderImages(product.id, [
          byUrl.get(url('r-3'))!,
          byUrl.get(url('r-1'))!,
          byUrl.get(url('r-2'))!,
        ])
      )

      // sortOrder follows the list given.
      const orderByUrl = new Map(reordered.map((i) => [i.url, i.sortOrder]))
      expect(orderByUrl.get(url('r-3'))).toBe(0)
      expect(orderByUrl.get(url('r-1'))).toBe(1)
      expect(orderByUrl.get(url('r-2'))).toBe(2)

      // The returned sequence is not the given one: IMAGE_ORDER sorts the cover
      // first regardless of sortOrder, because a gallery leads with the cover.
      // Reordering changes display order among the rest, never which image is
      // the cover.
      expect(reordered[0]!.url).toBe(url('r-1'))
      expect(reordered[0]!.isCover).toBe(true)
      expect(reordered.map((i) => i.url)).toEqual([url('r-1'), url('r-3'), url('r-2')])
    })

    it('rejects a partial list', async () => {
      // A partial list would leave the omitted images at whatever sortOrder they
      // held, interleaving them unpredictably with the renumbered ones.
      const product = await createProduct([{ url: url('pt-1') }, { url: url('pt-2') }])

      await expect(
        asTenant(() => products.reorderImages(product.id, [product.images[0]!.id]))
      ).rejects.toThrow(/INCOMPLETE_IMAGE_ORDER|every image/i)
    })

    it('rejects a duplicated id', async () => {
      const product = await createProduct([{ url: url('dp-1') }, { url: url('dp-2') }])
      const first = product.images[0]!.id

      await expect(
        asTenant(() => products.reorderImages(product.id, [first, first]))
      ).rejects.toThrow(/DUPLICATE_IMAGE_ID|unique/i)
    })

    it('rejects an id belonging to another product', async () => {
      const a = await createProduct([{ url: url('x-1') }])
      const b = await createProduct([{ url: url('y-1') }])

      await expect(
        asTenant(() => products.reorderImages(a.id, [b.images[0]!.id]))
      ).rejects.toThrow(/INCOMPLETE_IMAGE_ORDER|every image/i)
    })
  })

  describe('tenant scoping', () => {
    it('images of another tenant are invisible', async () => {
      const mine = await createProduct([{ url: url('mine') }])
      const theirs = await createProduct([{ url: url('theirs') }], asOtherTenant)

      const visible = await asTenant(() => dbApp.productImage.findMany({}))
      const urls = visible.map((i) => i.url)

      expect(urls).toContain(url('mine'))
      expect(urls).not.toContain(url('theirs'))
      expect(visible.every((i) => i.tenantId === tenantId)).toBe(true)
      expect(mine.images[0]!.tenantId).not.toBe(theirs.images[0]!.tenantId)
    })

    it('another tenant cannot read one of our images by id', async () => {
      // Layer one cannot merge tenantId into a findUnique `where`, so this is
      // RLS doing the work — which is why product_images must be in RLS_TABLES.
      const product = await createProduct([{ url: url('secret') }])
      const imageId = product.images[0]!.id

      const found = await asOtherTenant(() =>
        dbApp.productImage.findUnique({ where: { id: imageId } })
      )

      expect(found).toBeNull()
    })

    it('another tenant cannot delete one of our images', async () => {
      const product = await createProduct([{ url: url('protected') }])
      const imageId = product.images[0]!.id

      const removed = await asOtherTenant(() => products.deleteImage(imageId))

      expect(removed).toBe(false)
      const stillThere = await asTenant(() =>
        dbApp.productImage.findUnique({ where: { id: imageId } })
      )
      expect(stillThere).not.toBeNull()
    })
  })
})
