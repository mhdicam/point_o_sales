/**
 * Unit service — S3-02, design §3.2.
 *
 * Units represent measurements (kg, ml, pcs) and nest via `baseUnitId`. The key
 * invariant: a base unit (baseUnitId = null) has factor = UNIT_FACTOR_SCALE; a
 * derived unit stores its scaled conversion factor relative to that base.
 *
 * Conversion is only valid within one dimension — cross-dimension (grams to ml)
 * needs a per-ingredient density, which is deliberately out of scope.
 */

import type { BrewsyncClient, Prisma, UnitDimension } from '@brewsync/db'
import { UNIT_FACTOR_SCALE } from '@brewsync/shared'
import { badRequest, notFound } from '../http-error.js'

interface CreateUnitInput {
  code: string
  name: string
  dimension: UnitDimension
  baseUnitId?: string | null
  factor?: bigint
}

type UpdateUnitInput = Partial<CreateUnitInput> & { isActive?: boolean }

export class UnitService {
  constructor(private readonly db: BrewsyncClient) {}

  async create(input: CreateUnitInput) {
    // A base unit must have factor = UNIT_FACTOR_SCALE; a derived unit must
    // reference a valid base and may carry a custom factor.
    if (!input.baseUnitId) {
      if (input.factor && input.factor !== UNIT_FACTOR_SCALE) {
        throw badRequest(
          'BASE_UNIT_FACTOR',
          `A base unit must have factor = ${UNIT_FACTOR_SCALE.toString()}`
        )
      }
    } else {
      const baseUnit = await this.requireExists(input.baseUnitId)

      if (baseUnit.dimension !== input.dimension) {
        throw badRequest(
          'DIMENSION_MISMATCH',
          `Unit dimension (${input.dimension}) does not match base unit dimension (${baseUnit.dimension})`
        )
      }

      // Guard against cycles. Walk up from the proposed base; if we meet a null
      // baseUnitId, it's safe. If we loop back to ourselves (impossible on
      // insert, but the shape is here for update), reject.
      await this.assertNotDescendant(null, input.baseUnitId)
    }

    return await this.db.unit.create({
      data: {
        code: input.code,
        name: input.name,
        dimension: input.dimension,
        baseUnitId: input.baseUnitId ?? null,
        factor: input.factor ?? UNIT_FACTOR_SCALE,
      } as unknown as Prisma.UnitCreateInput,
    })
  }

  async update(unitId: string, input: UpdateUnitInput) {
    const existing = await this.requireExists(unitId)

    // Dimension changes are forbidden once a unit exists — a unit may have been
    // used in stock movements or recipes, and retroactively changing its dimension
    // would corrupt those records.
    if (input.dimension !== undefined && input.dimension !== existing.dimension) {
      throw badRequest('DIMENSION_CHANGE', 'Cannot change the dimension of an existing unit')
    }

    // Re-basing (changing baseUnitId) is the dangerous operation. Three checks:
    // 1. The new base must be in the same dimension.
    // 2. Cannot make a unit its own base.
    // 3. Cannot create a cycle.
    if (input.baseUnitId !== undefined) {
      if (input.baseUnitId === null) {
        // Converting to a base unit — factor must become UNIT_FACTOR_SCALE.
        if (input.factor !== undefined && input.factor !== UNIT_FACTOR_SCALE) {
          throw badRequest('BASE_UNIT_FACTOR', 'A base unit must have factor = 1000000')
        }
      } else {
        if (input.baseUnitId === unitId) {
          throw badRequest('UNIT_CYCLE', 'A unit cannot be its own base')
        }

        const newBase = await this.requireExists(input.baseUnitId)

        if (newBase.dimension !== existing.dimension) {
          throw badRequest(
            'DIMENSION_MISMATCH',
            `Cannot rebase to a unit in a different dimension`
          )
        }

        await this.assertNotDescendant(unitId, input.baseUnitId)
      }
    }

    // Factor changes: if the unit is becoming a base (baseUnitId -> null), force
    // factor to UNIT_FACTOR_SCALE. Otherwise honor the provided factor.
    const finalFactor =
      input.baseUnitId === null
        ? UNIT_FACTOR_SCALE
        : input.factor !== undefined
          ? input.factor
          : undefined

    return await this.db.unit.update({
      where: { id: unitId },
      data: {
        ...(input.code !== undefined && { code: input.code }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.baseUnitId !== undefined && { baseUnitId: input.baseUnitId }),
        ...(finalFactor !== undefined && { factor: finalFactor }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      },
    })
  }

  /**
   * Deletes a unit. Refuses if it is a base for other units, or if any
   * ProductVariant references it — `onDelete: Restrict` FK errors become 400s.
   */
  async delete(unitId: string): Promise<boolean> {
    const unit = await this.db.unit.findUnique({
      where: { id: unitId },
      include: {
        _count: { select: { derivedUnits: true, sellVariants: true, stockVariants: true } },
      },
    })

    if (!unit) return false

    if (unit._count.derivedUnits > 0) {
      throw badRequest(
        'UNIT_HAS_DERIVED',
        `Unit is the base for ${unit._count.derivedUnits} derived unit(s). Rebase or delete them first.`
      )
    }

    const totalVariants = unit._count.sellVariants + unit._count.stockVariants
    if (totalVariants > 0) {
      throw badRequest(
        'UNIT_IN_USE',
        `Unit is used by ${totalVariants} product variant(s). Reassign them first.`
      )
    }

    await this.db.unit.delete({ where: { id: unitId } })
    return true
  }

  async list(opts: { dimension?: UnitDimension; includeInactive?: boolean } = {}) {
    return await this.db.unit.findMany({
      where: {
        ...(opts.dimension && { dimension: opts.dimension }),
        ...(opts.includeInactive ? {} : { isActive: true }),
      },
      include: {
        baseUnit: { select: { id: true, code: true, name: true } },
        _count: { select: { derivedUnits: true } },
      },
      orderBy: [{ dimension: 'asc' }, { code: 'asc' }],
    })
  }

  async getById(unitId: string) {
    const unit = await this.db.unit.findUnique({
      where: { id: unitId },
      include: {
        baseUnit: true,
        derivedUnits: { where: { isActive: true }, orderBy: { code: 'asc' } },
      },
    })

    if (!unit) {
      throw notFound('UNIT_NOT_FOUND', 'Unit not found')
    }

    return unit
  }

  private async requireExists(unitId: string) {
    const unit = await this.db.unit.findUnique({
      where: { id: unitId },
      select: { id: true, dimension: true, baseUnitId: true },
    })
    if (!unit) {
      throw notFound('UNIT_NOT_FOUND', `Unit ${unitId} not found`)
    }
    return unit
  }

  /**
   * Rejects re-basing a unit under one of its own descendants.
   *
   * Walks up from the *proposed base*: if we meet `unitId` on the way to the
   * root, the proposed base sits beneath it and the move would close a ring.
   *
   * @param unitId The unit being modified (null for insert, where no cycle is possible yet).
   * @param proposedBaseId The new baseUnitId.
   */
  private async assertNotDescendant(
    unitId: string | null,
    proposedBaseId: string
  ): Promise<void> {
    const seen = new Set<string>()
    let cursor: string | null = proposedBaseId

    while (cursor) {
      if (cursor === unitId) {
        throw badRequest('UNIT_CYCLE', 'Cannot rebase a unit under one of its own descendants')
      }
      if (seen.has(cursor)) break
      seen.add(cursor)

      const node: { baseUnitId: string | null } | null = await this.db.unit.findUnique({
        where: { id: cursor },
        select: { baseUnitId: true },
      })
      cursor = node?.baseUnitId ?? null
    }
  }
}
