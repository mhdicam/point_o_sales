/**
 * Modifier service — S3-04, design §3.4.
 *
 * A ModifierGroup holds selection rules (min/max/required); Modifiers are its
 * options, each with a signed `priceDelta`. Groups attach to products via the
 * ProductModifierGroup join, so "Sugar level" is defined once and reused.
 *
 * Selection rules are validated here at definition time — `minSelect` above
 * `maxSelect` is unsatisfiable, and a required group with no active options
 * would block every order for its product. S4 validates the *choices* against
 * these rules when an order item is built.
 */

import type { BrewsyncClient, Prisma } from '@brewsync/db'
import { badRequest, notFound } from '../http-error.js'

interface CreateGroupInput {
  name: string
  minSelect?: number
  maxSelect?: number | null
  isRequired?: boolean
  sortOrder?: number
}

type UpdateGroupInput = Partial<CreateGroupInput> & { isActive?: boolean }

interface CreateModifierInput {
  name: string
  priceDelta?: bigint
  isDefault?: boolean
  sortOrder?: number
}

type UpdateModifierInput = Partial<CreateModifierInput> & { isActive?: boolean }

export class ModifierService {
  constructor(private readonly db: BrewsyncClient) {}

  /** ---- Group operations ---- */

  async createGroup(input: CreateGroupInput) {
    this.assertSelectionRules({
      minSelect: input.minSelect ?? 0,
      maxSelect: input.maxSelect ?? null,
      isRequired: input.isRequired ?? false,
    })

    return await this.db.modifierGroup.create({
      data: {
        name: input.name,
        minSelect: input.minSelect ?? 0,
        maxSelect: input.maxSelect ?? null,
        isRequired: input.isRequired ?? false,
        sortOrder: input.sortOrder ?? 0,
      } as unknown as Prisma.ModifierGroupCreateInput,
    })
  }

  async updateGroup(groupId: string, input: UpdateGroupInput) {
    const existing = await this.requireGroup(groupId)

    // Validate the *resulting* rule set, not just the fields that changed —
    // raising minSelect alone can cross a maxSelect that was set earlier.
    this.assertSelectionRules({
      minSelect: input.minSelect ?? existing.minSelect,
      maxSelect: input.maxSelect !== undefined ? input.maxSelect : existing.maxSelect,
      isRequired: input.isRequired ?? existing.isRequired,
    })

    return await this.db.modifierGroup.update({
      where: { id: groupId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.minSelect !== undefined && { minSelect: input.minSelect }),
        ...(input.maxSelect !== undefined && { maxSelect: input.maxSelect }),
        ...(input.isRequired !== undefined && { isRequired: input.isRequired }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
    })
  }

  /**
   * Deletes a group. Modifiers cascade, but an attachment to a live product does
   * not — detach it first, so removing a shared group cannot silently change what
   * a product offers.
   */
  async deleteGroup(groupId: string): Promise<boolean> {
    const group = await this.db.modifierGroup.findUnique({
      where: { id: groupId },
      include: { _count: { select: { products: true } } },
    })

    if (!group) return false

    if (group._count.products > 0) {
      throw badRequest(
        'GROUP_IN_USE',
        `Group is attached to ${group._count.products} product(s). Detach it first.`
      )
    }

    await this.db.modifierGroup.delete({ where: { id: groupId } })
    return true
  }

  async listGroups(opts: { includeInactive?: boolean } = {}) {
    return await this.db.modifierGroup.findMany({
      where: opts.includeInactive ? {} : { isActive: true },
      include: {
        modifiers: {
          ...(opts.includeInactive ? {} : { where: { isActive: true } }),
          orderBy: { sortOrder: 'asc' },
        },
        _count: { select: { products: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
  }

  async getGroupById(groupId: string) {
    const group = await this.db.modifierGroup.findUnique({
      where: { id: groupId },
      include: {
        modifiers: { orderBy: { sortOrder: 'asc' } },
        products: { include: { product: { select: { id: true, name: true } } } },
      },
    })

    if (!group) {
      throw notFound('MODIFIER_GROUP_NOT_FOUND', 'Modifier group not found')
    }

    return group
  }

  /** ---- Modifier (option) operations ---- */

  async createModifier(groupId: string, input: CreateModifierInput) {
    await this.requireGroup(groupId)

    return await this.db.modifier.create({
      data: {
        groupId,
        name: input.name,
        priceDelta: input.priceDelta ?? 0n,
        isDefault: input.isDefault ?? false,
        sortOrder: input.sortOrder ?? 0,
      } as unknown as Prisma.ModifierCreateInput,
    })
  }

  async updateModifier(modifierId: string, input: UpdateModifierInput) {
    const existing = await this.db.modifier.findUnique({
      where: { id: modifierId },
      select: { id: true, groupId: true },
    })
    if (!existing) {
      throw notFound('MODIFIER_NOT_FOUND', 'Modifier not found')
    }

    return await this.db.modifier.update({
      where: { id: modifierId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.priceDelta !== undefined && { priceDelta: input.priceDelta }),
        ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      },
    })
  }

  /**
   * Deletes a modifier. Refuses if removing it would leave a required group with
   * fewer active options than `minSelect` demands — that group would make every
   * order for its product unsatisfiable.
   */
  async deleteModifier(modifierId: string): Promise<boolean> {
    const modifier = await this.db.modifier.findUnique({
      where: { id: modifierId },
      select: { id: true, isActive: true, groupId: true },
    })

    if (!modifier) return false

    if (modifier.isActive) {
      const group = await this.db.modifierGroup.findUnique({
        where: { id: modifier.groupId },
        select: {
          minSelect: true,
          isRequired: true,
          _count: { select: { modifiers: { where: { isActive: true } } } },
        },
      })

      if (group) {
        const remaining = group._count.modifiers - 1
        const floor = group.isRequired ? Math.max(group.minSelect, 1) : group.minSelect

        if (remaining < floor) {
          throw badRequest(
            'GROUP_WOULD_BE_UNSATISFIABLE',
            `Group needs at least ${floor} active option(s); deleting this leaves ${remaining}.`
          )
        }
      }
    }

    await this.db.modifier.delete({ where: { id: modifierId } })
    return true
  }

  /** ---- Product attachment ---- */

  async attachToProduct(productId: string, groupId: string, sortOrder = 0) {
    await this.requireProduct(productId)
    await this.requireGroup(groupId)

    const existing = await this.db.productModifierGroup.findUnique({
      where: { productId_groupId: { productId, groupId } },
    })

    if (existing) {
      // Idempotent: re-attaching only updates the display order.
      return await this.db.productModifierGroup.update({
        where: { id: existing.id },
        data: { sortOrder },
      })
    }

    return await this.db.productModifierGroup.create({
      data: { productId, groupId, sortOrder } as unknown as Prisma.ProductModifierGroupCreateInput,
    })
  }

  async detachFromProduct(productId: string, groupId: string): Promise<boolean> {
    const existing = await this.db.productModifierGroup.findUnique({
      where: { productId_groupId: { productId, groupId } },
      select: { id: true },
    })

    if (!existing) return false

    await this.db.productModifierGroup.delete({ where: { id: existing.id } })
    return true
  }

  /**
   * Groups attached to a product, with their active options — the shape the POS
   * needs to render the modifier sheet when an item is tapped.
   */
  async listForProduct(productId: string) {
    await this.requireProduct(productId)

    const attachments = await this.db.productModifierGroup.findMany({
      where: { productId },
      include: {
        group: {
          include: {
            modifiers: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
          },
        },
      },
      orderBy: { sortOrder: 'asc' },
    })

    return attachments
      .filter((a) => a.group.isActive)
      .map((a) => ({ ...a.group, attachmentSortOrder: a.sortOrder }))
  }

  /**
   * Rejects rule sets no selection can satisfy.
   *
   * `maxSelect < minSelect` is contradictory. A required group with
   * `maxSelect = 0` offers nothing yet demands a choice.
   */
  private assertSelectionRules(rules: {
    minSelect: number
    maxSelect: number | null
    isRequired: boolean
  }): void {
    if (rules.minSelect < 0) {
      throw badRequest('INVALID_SELECTION_RULES', 'minSelect cannot be negative')
    }

    if (rules.maxSelect !== null) {
      if (rules.maxSelect < rules.minSelect) {
        throw badRequest(
          'INVALID_SELECTION_RULES',
          `maxSelect (${rules.maxSelect}) cannot be below minSelect (${rules.minSelect})`
        )
      }
      if (rules.isRequired && rules.maxSelect === 0) {
        throw badRequest(
          'INVALID_SELECTION_RULES',
          'A required group cannot have maxSelect = 0'
        )
      }
    }
  }

  private async requireGroup(groupId: string) {
    const group = await this.db.modifierGroup.findUnique({
      where: { id: groupId },
      select: { id: true, minSelect: true, maxSelect: true, isRequired: true },
    })
    if (!group) {
      throw notFound('MODIFIER_GROUP_NOT_FOUND', `Modifier group ${groupId} not found`)
    }
    return group
  }

  private async requireProduct(productId: string): Promise<void> {
    const found = await this.db.product.findUnique({
      where: { id: productId },
      select: { id: true },
    })
    if (!found) {
      throw notFound('PRODUCT_NOT_FOUND', `Product ${productId} not found`)
    }
  }
}
