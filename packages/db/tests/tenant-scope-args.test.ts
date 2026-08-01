/**
 * S1-07 layer-one unit tests — argument scoping.
 *
 * These exist because the integration suite cannot see a layer-one regression:
 * with RLS active, deleting the tenantId injection entirely still returns the
 * right rows, because layer two covers it. Defence in depth means each layer
 * has to be tested with the other one out of the picture.
 *
 * So: assert directly on what the extension hands to Prisma.
 */

import { describe, it, expect } from 'vitest'
import { scopeArgs, TENANT_SCOPED_MODELS, GLOBAL_MODELS } from '../src/tenant-scope.js'

const TENANT = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'

describe('scopeArgs — layer one', () => {
  describe('reads', () => {
    for (const op of ['findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']) {
      it(`${op}: injects tenantId when where is absent`, () => {
        const out = scopeArgs(op, {}, TENANT, 'Outlet')
        expect(out['where']).toEqual({ tenantId: TENANT })
      })

      it(`${op}: preserves other filters`, () => {
        const out = scopeArgs(op, { where: { code: 'DPK' } }, TENANT, 'Outlet')
        expect(out['where']).toEqual({ code: 'DPK', tenantId: TENANT })
      })

      it(`${op}: overwrites a caller-supplied tenantId — cannot widen scope`, () => {
        const out = scopeArgs(op, { where: { tenantId: OTHER } }, TENANT, 'Outlet')
        expect(out['where']).toEqual({ tenantId: TENANT })
      })
    }
  })

  describe('mutating where-ops', () => {
    for (const op of ['updateMany', 'deleteMany']) {
      it(`${op}: injects tenantId`, () => {
        const out = scopeArgs(op, { where: { status: 'ACTIVE' } }, TENANT, 'Outlet')
        expect(out['where']).toEqual({ status: 'ACTIVE', tenantId: TENANT })
      })

      it(`${op}: a caller-supplied tenantId cannot redirect the write`, () => {
        // The dangerous case: deleteMany({ where: { tenantId: someoneElse } }).
        const out = scopeArgs(op, { where: { tenantId: OTHER } }, TENANT, 'Outlet')
        expect(out['where']).toEqual({ tenantId: TENANT })
      })
    }
  })

  describe('unique-target ops', () => {
    for (const op of ['findUnique', 'findUniqueOrThrow', 'update', 'delete']) {
      it(`${op}: args pass through untouched (RLS covers these)`, () => {
        // Prisma only accepts unique fields in `where` here, so tenantId cannot
        // be merged in. Layer two is what stops a cross-tenant id — which is
        // exactly why the RLS tests below are not optional.
        const input = { where: { id: 'some-uuid' } }
        expect(scopeArgs(op, { ...input }, TENANT, 'Outlet')).toEqual(input)
      })
    }
  })

  describe('writes', () => {
    it('create: injects tenantId into data', () => {
      const out = scopeArgs('create', { data: { code: 'DPK', name: 'Depok' } }, TENANT, 'Outlet')
      expect(out['data']).toEqual({ code: 'DPK', name: 'Depok', tenantId: TENANT })
    })

    it('create: overwrites a caller-supplied tenantId', () => {
      const out = scopeArgs('create', { data: { code: 'DPK', tenantId: OTHER } }, TENANT, 'Outlet')
      expect(out['data']).toEqual({ code: 'DPK', tenantId: TENANT })
    })

    it('create: leaves an explicit nested tenant relation alone', () => {
      const data = { code: 'DPK', tenant: { connect: { id: OTHER } } }
      const out = scopeArgs('create', { data: { ...data } }, TENANT, 'Outlet')
      // Deliberately not rewritten — but note it means a nested connect is NOT
      // scoped by layer one, so RLS `WITH CHECK` is the guard that matters here.
      expect(out['data']).toEqual(data)
    })

    it('createMany: injects tenantId into every row', () => {
      const out = scopeArgs(
        'createMany',
        { data: [{ code: 'A' }, { code: 'B', tenantId: OTHER }] },
        TENANT,
        'Outlet'
      )
      expect(out['data']).toEqual([
        { code: 'A', tenantId: TENANT },
        { code: 'B', tenantId: TENANT },
      ])
    })

    it('createMany: handles a single-object data payload', () => {
      const out = scopeArgs('createMany', { data: { code: 'A' } }, TENANT, 'Outlet')
      expect(out['data']).toEqual({ code: 'A', tenantId: TENANT })
    })

    it('createManyAndReturn: injects tenantId into every row', () => {
      const out = scopeArgs('createManyAndReturn', { data: [{ code: 'A' }] }, TENANT, 'Outlet')
      expect(out['data']).toEqual([{ code: 'A', tenantId: TENANT }])
    })

    it('upsert: injects tenantId into the create branch', () => {
      const out = scopeArgs(
        'upsert',
        { where: { id: 'x' }, create: { code: 'A' }, update: { name: 'n' } },
        TENANT,
        'Outlet'
      )
      expect(out['create']).toEqual({ code: 'A', tenantId: TENANT })
    })

    it('upsert: does not stamp tenantId onto the update branch', () => {
      // Writing it there would let a caller move an existing row to another
      // tenant, which is the one thing layer one must never enable.
      const out = scopeArgs(
        'upsert',
        { where: { id: 'x' }, create: { code: 'A' }, update: { name: 'n' } },
        TENANT,
        'Outlet'
      )
      expect(out['update']).toEqual({ name: 'n' })
    })
  })

  /**
   * The regression this recursion exists for: nested rows never received a
   * tenantId, and since their generated types require the `tenant` relation,
   * Prisma rejected the entire call with "Argument `tenant` is missing." —
   * ProductService.create could not create a single product.
   */
  describe('nested writes', () => {
    it('create: injects tenantId into nested create rows', () => {
      const out = scopeArgs(
        'create',
        {
          data: {
            name: 'Kopi Susu',
            slug: 'kopi-susu',
            variants: { create: [{ sku: 'KS-1', name: 'Regular' }, { sku: 'KS-2', name: 'Large' }] },
            images: { create: [{ url: 'https://cdn/a.jpg', isCover: true }] },
          },
        },
        TENANT,
        'Product'
      )

      expect(out['data']).toEqual({
        name: 'Kopi Susu',
        slug: 'kopi-susu',
        tenantId: TENANT,
        variants: {
          create: [
            { sku: 'KS-1', name: 'Regular', tenantId: TENANT },
            { sku: 'KS-2', name: 'Large', tenantId: TENANT },
          ],
        },
        images: { create: [{ url: 'https://cdn/a.jpg', isCover: true, tenantId: TENANT }] },
      })
    })

    it('create: handles a single-object nested create', () => {
      const out = scopeArgs(
        'create',
        { data: { name: 'P', slug: 'p', variants: { create: { sku: 'A', name: 'D' } } } },
        TENANT,
        'Product'
      )
      const data = out['data'] as Record<string, Record<string, unknown>>
      expect(data['variants']!['create']).toEqual({ sku: 'A', name: 'D', tenantId: TENANT })
    })

    it('create: injects into nested createMany rows', () => {
      const out = scopeArgs(
        'create',
        {
          data: {
            name: 'P',
            slug: 'p',
            images: { createMany: { data: [{ url: 'a' }, { url: 'b' }] } },
          },
        },
        TENANT,
        'Product'
      )
      const data = out['data'] as Record<string, Record<string, Record<string, unknown>>>
      expect(data['images']!['createMany']!['data']).toEqual([
        { url: 'a', tenantId: TENANT },
        { url: 'b', tenantId: TENANT },
      ])
    })

    it('create: recurses through more than one level', () => {
      const out = scopeArgs(
        'create',
        {
          data: {
            name: 'Group',
            modifiers: { create: [{ name: 'Extra shot', priceDelta: 5000 }] },
          },
        },
        TENANT,
        'ModifierGroup'
      )
      const data = out['data'] as Record<string, Record<string, unknown>>
      expect(data['tenantId']).toBe(TENANT)
      expect(data['modifiers']!['create']).toEqual([
        { name: 'Extra shot', priceDelta: 5000, tenantId: TENANT },
      ])
    })

    it('create: leaves connect alone — RLS USING guards an existing row', () => {
      const out = scopeArgs(
        'create',
        { data: { name: 'P', slug: 'p', category: { connect: { id: OTHER } } } },
        TENANT,
        'Product'
      )
      const data = out['data'] as Record<string, unknown>
      expect(data['category']).toEqual({ connect: { id: OTHER } })
    })

    it('create: injects into the create half of connectOrCreate only', () => {
      const out = scopeArgs(
        'create',
        {
          data: {
            name: 'P',
            slug: 'p',
            category: { connectOrCreate: { where: { id: 'c1' }, create: { name: 'Minuman' } } },
          },
        },
        TENANT,
        'Product'
      )
      const data = out['data'] as Record<string, Record<string, Record<string, unknown>>>
      expect(data['category']!['connectOrCreate']).toEqual({
        where: { id: 'c1' },
        create: { name: 'Minuman', tenantId: TENANT },
      })
    })

    it('update: walks nested creates but does not restamp the row itself', () => {
      const out = scopeArgs(
        'update',
        {
          where: { id: 'p1' },
          data: { name: 'Renamed', images: { create: [{ url: 'https://cdn/new.jpg' }] } },
        },
        TENANT,
        'Product'
      )
      const data = out['data'] as Record<string, unknown>
      expect(data['tenantId']).toBeUndefined()
      expect((data['images'] as Record<string, unknown>)['create']).toEqual([
        { url: 'https://cdn/new.jpg', tenantId: TENANT },
      ])
    })

    it('update: nested update payloads are not stamped', () => {
      const out = scopeArgs(
        'update',
        {
          where: { id: 'p1' },
          data: { images: { update: { where: { id: 'i1' }, data: { alt: 'new alt' } } } },
        },
        TENANT,
        'Product'
      )
      const data = out['data'] as Record<string, Record<string, Record<string, unknown>>>
      expect(data['images']!['update']).toEqual({ where: { id: 'i1' }, data: { alt: 'new alt' } })
    })

    it('update: nested upsert injects into create, not update', () => {
      const out = scopeArgs(
        'update',
        {
          where: { id: 'p1' },
          data: {
            images: {
              upsert: { where: { id: 'i1' }, create: { url: 'a' }, update: { alt: 'z' } },
            },
          },
        },
        TENANT,
        'Product'
      )
      const data = out['data'] as Record<string, Record<string, Record<string, unknown>>>
      expect(data['images']!['upsert']).toEqual({
        where: { id: 'i1' },
        create: { url: 'a', tenantId: TENANT },
        update: { alt: 'z' },
      })
    })

    it('create: leaves nested rows of a global model alone', () => {
      // RolePermission has no tenantId column, so stamping one would make Prisma
      // reject a call that works today (onboarding + role services rely on it).
      const out = scopeArgs(
        'create',
        {
          data: {
            name: 'Kasir',
            permissions: { create: [{ permissionId: 'perm-1' }] },
          },
        },
        TENANT,
        'Role'
      )
      const data = out['data'] as Record<string, Record<string, unknown>>
      expect(data['tenantId']).toBe(TENANT)
      expect(data['permissions']!['create']).toEqual([{ permissionId: 'perm-1' }])
    })

    it('does not mutate the caller-supplied nested payload', () => {
      const nested = { sku: 'A', name: 'D' }
      const args = { data: { name: 'P', slug: 'p', variants: { create: [nested] } } }
      scopeArgs('create', args, TENANT, 'Product')
      expect(nested).toEqual({ sku: 'A', name: 'D' })
    })
  })

  it('does not mutate the tenantId it was given', () => {
    const out = scopeArgs('findMany', {}, TENANT, 'Outlet')
    expect((out['where'] as Record<string, unknown>)['tenantId']).toBe(TENANT)
  })
})

describe('model allowlists', () => {
  it('scoped and global sets do not overlap', () => {
    const overlap = [...TENANT_SCOPED_MODELS].filter((m) => GLOBAL_MODELS.has(m))
    expect(overlap).toEqual([])
  })
})
