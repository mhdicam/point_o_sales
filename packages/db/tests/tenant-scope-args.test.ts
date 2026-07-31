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
        const out = scopeArgs(op, {}, TENANT)
        expect(out['where']).toEqual({ tenantId: TENANT })
      })

      it(`${op}: preserves other filters`, () => {
        const out = scopeArgs(op, { where: { code: 'DPK' } }, TENANT)
        expect(out['where']).toEqual({ code: 'DPK', tenantId: TENANT })
      })

      it(`${op}: overwrites a caller-supplied tenantId — cannot widen scope`, () => {
        const out = scopeArgs(op, { where: { tenantId: OTHER } }, TENANT)
        expect(out['where']).toEqual({ tenantId: TENANT })
      })
    }
  })

  describe('mutating where-ops', () => {
    for (const op of ['updateMany', 'deleteMany']) {
      it(`${op}: injects tenantId`, () => {
        const out = scopeArgs(op, { where: { status: 'ACTIVE' } }, TENANT)
        expect(out['where']).toEqual({ status: 'ACTIVE', tenantId: TENANT })
      })

      it(`${op}: a caller-supplied tenantId cannot redirect the write`, () => {
        // The dangerous case: deleteMany({ where: { tenantId: someoneElse } }).
        const out = scopeArgs(op, { where: { tenantId: OTHER } }, TENANT)
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
        expect(scopeArgs(op, { ...input }, TENANT)).toEqual(input)
      })
    }
  })

  describe('writes', () => {
    it('create: injects tenantId into data', () => {
      const out = scopeArgs('create', { data: { code: 'DPK', name: 'Depok' } }, TENANT)
      expect(out['data']).toEqual({ code: 'DPK', name: 'Depok', tenantId: TENANT })
    })

    it('create: overwrites a caller-supplied tenantId', () => {
      const out = scopeArgs('create', { data: { code: 'DPK', tenantId: OTHER } }, TENANT)
      expect(out['data']).toEqual({ code: 'DPK', tenantId: TENANT })
    })

    it('create: leaves an explicit nested tenant relation alone', () => {
      const data = { code: 'DPK', tenant: { connect: { id: OTHER } } }
      const out = scopeArgs('create', { data: { ...data } }, TENANT)
      // Deliberately not rewritten — but note it means a nested connect is NOT
      // scoped by layer one, so RLS `WITH CHECK` is the guard that matters here.
      expect(out['data']).toEqual(data)
    })

    it('createMany: injects tenantId into every row', () => {
      const out = scopeArgs(
        'createMany',
        { data: [{ code: 'A' }, { code: 'B', tenantId: OTHER }] },
        TENANT
      )
      expect(out['data']).toEqual([
        { code: 'A', tenantId: TENANT },
        { code: 'B', tenantId: TENANT },
      ])
    })

    it('createMany: handles a single-object data payload', () => {
      const out = scopeArgs('createMany', { data: { code: 'A' } }, TENANT)
      expect(out['data']).toEqual({ code: 'A', tenantId: TENANT })
    })

    it('createManyAndReturn: injects tenantId into every row', () => {
      const out = scopeArgs('createManyAndReturn', { data: [{ code: 'A' }] }, TENANT)
      expect(out['data']).toEqual([{ code: 'A', tenantId: TENANT }])
    })

    it('upsert: injects tenantId into the create branch', () => {
      const out = scopeArgs(
        'upsert',
        { where: { id: 'x' }, create: { code: 'A' }, update: { name: 'n' } },
        TENANT
      )
      expect(out['create']).toEqual({ code: 'A', tenantId: TENANT })
    })
  })

  it('does not mutate the tenantId it was given', () => {
    const out = scopeArgs('findMany', {}, TENANT)
    expect((out['where'] as Record<string, unknown>)['tenantId']).toBe(TENANT)
  })
})

describe('model allowlists', () => {
  it('scoped and global sets do not overlap', () => {
    const overlap = [...TENANT_SCOPED_MODELS].filter((m) => GLOBAL_MODELS.has(m))
    expect(overlap).toEqual([])
  })
})
