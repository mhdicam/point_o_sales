/**
 * Landing CMS admin service — S9-02, design §17.1.
 *
 * The authenticated counterpart to `PublicLandingService`: this is what the POS
 * admin drives to build a tenant's public page. Everything here runs under the
 * bound tenant context (the request has a token, tenant middleware bound the
 * GUC), so tenant scoping is the extension's job (standard #1) — no service ever
 * writes `where: { tenantId }` by hand.
 *
 * The model is a section-based CMS-lite:
 *   - ONE page per tenant (the per-tenant page, `outletId = null`). It is
 *     provisioned lazily on first read with `slug = tenant.slug` (globally
 *     unique, so `@@unique([tenantId, slug])` is trivially satisfied and the
 *     admin never has to pick a slug that might collide with another tenant).
 *   - Sections are ordered by `position`, unique per page. Reorder is a whole-
 *     list operation run in one transaction, in two passes, to dodge the unique
 *     index mid-swap (see `reorder`).
 *   - Publish flips DRAFT→PUBLISHED (+ `publishedAt`); unpublish flips back and
 *     makes the public `/p/:slug` read 404 again. The public read only ever
 *     serves PUBLISHED, so half-finished edits never leak (§17.1).
 *
 * Per-type `content` JSON is validated at the route boundary (one Zod schema per
 * type), so this layer takes already-valid `InputJsonValue` and just persists it.
 */

import {
  type BrewsyncClient,
  type LandingSectionType,
  Prisma,
  getTenantContext,
} from '@brewsync/db'
import { badRequest, conflict, notFound } from '../http-error.js'

export interface UpdateLandingMetaInput {
  title?: string
  description?: string | null
  theme?: Prisma.InputJsonValue | null
  orderingEnabled?: boolean
}

export interface AddSectionInput {
  type: LandingSectionType
  title?: string | null
  content: Prisma.InputJsonValue
  isVisible?: boolean
}

export interface UpdateSectionInput {
  title?: string | null
  content?: Prisma.InputJsonValue
  isVisible?: boolean
}

export interface ReorderItem {
  id: string
  position: number
}

/** The section shape returned to the admin — full content, both visible and not. */
const sectionSelect = {
  id: true,
  type: true,
  position: true,
  title: true,
  content: true,
  isVisible: true,
} as const

export class LandingService {
  constructor(private readonly db: BrewsyncClient) {}

  /**
   * Returns the tenant's landing page with all its sections (draft included), in
   * position order. Provisions a DRAFT page on first access so the admin always
   * has something to edit — `slug = tenant.slug` keeps it unique per tenant
   * without asking the admin to invent one. A concurrent first-access would race
   * on the unique index; the P2002 catch re-reads the winner.
   */
  async get() {
    const existing = await this.findPage()
    if (existing) return existing

    const tenantId = this.tenantId()
    const tenant = await this.db.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, name: true },
    })
    if (!tenant) throw notFound('TENANT_NOT_FOUND', 'Tenant not found')

    try {
      // tenantId is injected by the extension (standard #1) — never passed here.
      await this.db.landingPage.create({
        data: { slug: tenant.slug, title: tenant.name } as unknown as Prisma.LandingPageCreateInput,
      })
    } catch (error) {
      // A racing request created it first — fall through to the re-read.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error
      }
    }

    const page = await this.findPage()
    if (!page) throw notFound('LANDING_NOT_FOUND', 'Landing page not found')
    return page
  }

  /** Updates page meta (never the slug — that stays pinned to the tenant slug). */
  async updateMeta(input: UpdateLandingMetaInput) {
    const page = await this.get()

    const title = input.title?.trim()
    if (input.title !== undefined && title === '') {
      throw badRequest('VALIDATION_ERROR', 'Title is required')
    }

    await this.db.landingPage.update({
      where: { id: page.id },
      data: {
        ...(title !== undefined && { title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.theme !== undefined && { theme: input.theme ?? Prisma.DbNull }),
        ...(input.orderingEnabled !== undefined && { orderingEnabled: input.orderingEnabled }),
        updatedBy: this.actorId(),
      },
    })
    return this.get()
  }

  /** Appends a section at the end of the current order. */
  async addSection(input: AddSectionInput) {
    const page = await this.get()

    const last = await this.db.landingSection.findFirst({
      where: { landingPageId: page.id },
      orderBy: { position: 'desc' },
      select: { position: true },
    })
    const position = last ? last.position + 1 : 0

    await this.db.landingSection.create({
      data: {
        landingPageId: page.id,
        type: input.type,
        position,
        title: input.title ?? null,
        content: input.content,
        isVisible: input.isVisible ?? true,
      } as unknown as Prisma.LandingSectionCreateInput,
    })
    await this.touch(page.id)
    return this.get()
  }

  /**
   * The persisted type of a section on this tenant's page. The route uses it to
   * pick the right content schema on update (the body cannot change the type, so
   * validation keys off what is already stored). Throws 404 if it is not ours.
   */
  async getSectionType(id: string): Promise<LandingSectionType> {
    const page = await this.get()
    const section = await this.db.landingSection.findFirst({
      where: { id, landingPageId: page.id },
      select: { type: true },
    })
    if (!section) throw notFound('LANDING_SECTION_NOT_FOUND', 'Section not found')
    return section.type
  }

  /** Updates a section's editable fields; `type` and `position` are fixed here. */
  async updateSection(id: string, input: UpdateSectionInput) {
    const page = await this.get()
    await this.requireSection(page.id, id)

    await this.db.landingSection.update({
      where: { id },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.content !== undefined && { content: input.content }),
        ...(input.isVisible !== undefined && { isVisible: input.isVisible }),
      },
    })
    await this.touch(page.id)
    return this.get()
  }

  /** Removes a section. Remaining positions are left as-is (gaps are harmless). */
  async removeSection(id: string) {
    const page = await this.get()
    await this.requireSection(page.id, id)
    await this.db.landingSection.delete({ where: { id } })
    await this.touch(page.id)
    return this.get()
  }

  /**
   * Reorders the whole section list. `items` must name every section of the page
   * exactly once, with a contiguous 0..n-1 position set. Runs in one transaction
   * in two passes: first parks every row at a negative position (unique, and
   * disjoint from the target 0..n-1 range), then writes the final positions —
   * so the `@@unique([landingPageId, position])` index is never violated mid-swap.
   */
  async reorder(items: ReorderItem[]) {
    const page = await this.get()

    const current = await this.db.landingSection.findMany({
      where: { landingPageId: page.id },
      select: { id: true },
    })
    const currentIds = new Set(current.map((s) => s.id))
    const givenIds = new Set(items.map((i) => i.id))

    if (items.length !== current.length || currentIds.size !== givenIds.size) {
      throw badRequest('VALIDATION_ERROR', 'Reorder must list every section exactly once')
    }
    for (const id of givenIds) {
      if (!currentIds.has(id)) {
        throw badRequest('VALIDATION_ERROR', 'Reorder references a section that is not on this page')
      }
    }
    const positions = items.map((i) => i.position).sort((a, b) => a - b)
    const contiguous = positions.every((p, index) => p === index)
    if (!contiguous) {
      throw badRequest('VALIDATION_ERROR', 'Reorder positions must be 0..n-1 with no gaps or repeats')
    }

    await this.db.$transaction(async (tx) => {
      // Pass 1 — park at negative positions so no two rows collide with a target.
      await Promise.all(
        items.map((item, index) =>
          tx.landingSection.update({ where: { id: item.id }, data: { position: -(index + 1) } })
        )
      )
      // Pass 2 — write the final positions.
      await Promise.all(
        items.map((item) =>
          tx.landingSection.update({ where: { id: item.id }, data: { position: item.position } })
        )
      )
    })
    await this.touch(page.id)
    return this.get()
  }

  /** DRAFT → PUBLISHED. Idempotent-ish: re-publishing refreshes `publishedAt`. */
  async publish() {
    const page = await this.get()
    await this.db.landingPage.update({
      where: { id: page.id },
      data: { status: 'PUBLISHED', publishedAt: new Date(), updatedBy: this.actorId() },
    })
    return this.get()
  }

  /** PUBLISHED → DRAFT. Makes the public `/p/:slug` read 404 again. */
  async unpublish() {
    const page = await this.get()
    if (page.status !== 'PUBLISHED') {
      throw conflict('LANDING_NOT_PUBLISHED', 'The page is not currently published')
    }
    await this.db.landingPage.update({
      where: { id: page.id },
      data: { status: 'DRAFT', publishedAt: null, updatedBy: this.actorId() },
    })
    return this.get()
  }

  // --- internals -----------------------------------------------------------

  /** The per-tenant page (`outletId = null`) with its ordered sections, or null. */
  private async findPage() {
    return this.db.landingPage.findFirst({
      where: { outletId: null },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        theme: true,
        orderingEnabled: true,
        status: true,
        publishedAt: true,
        updatedAt: true,
        sections: { orderBy: { position: 'asc' }, select: sectionSelect },
      },
    })
  }

  /** Asserts a section id belongs to this page (scoping is already enforced). */
  private async requireSection(pageId: string, id: string): Promise<void> {
    const section = await this.db.landingSection.findFirst({
      where: { id, landingPageId: pageId },
      select: { id: true },
    })
    if (!section) throw notFound('LANDING_SECTION_NOT_FOUND', 'Section not found')
  }

  /** Bumps the page's audit fields after a section-level change. */
  private async touch(pageId: string): Promise<void> {
    await this.db.landingPage.update({
      where: { id: pageId },
      data: { updatedBy: this.actorId() },
    })
  }

  private tenantId(): string {
    const ctx = getTenantContext()
    if (!ctx?.tenantId) throw badRequest('NO_TENANT_CONTEXT', 'Tenant context is required')
    return ctx.tenantId
  }

  private actorId(): string | null {
    return getTenantContext()?.userId ?? null
  }
}
