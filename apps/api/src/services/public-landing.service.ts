/**
 * Public landing page read — S9-03, design §17 / §17.1.
 *
 * The public face of a tenant's landing page. Like `QrOrderService`, this is the
 * seam between a public, unauthenticated request and the tenant world:
 *
 *   1. `resolveSlug(slug)` is the ONE place a client string maps to a tenant. It
 *      runs `runUnscoped` (like the outbox worker / QR resolve) because no tenant
 *      context exists yet and RLS returns zero rows without a bound GUC. Only a
 *      PUBLISHED page resolves; everything downstream uses the *resolved* tenant/
 *      outlet ids — never client input.
 *   2. `buildPage(resolved)` binds that resolved context via
 *      `runWithTenantContext`, asserts the `landingPage` feature is on, and reads
 *      the page + its ordered sections. CATALOG sections pull products LIVE from
 *      master (§3) via `ProductService` — never a copy — so an edit to a product
 *      shows immediately and a deactivated product simply drops.
 *
 * A missing page, a draft, or a disabled feature all yield the same opaque
 * `LANDING_INVALID` (404) — nothing about tenant structure or publish state
 * leaks, exactly as QR masks a disabled toggle behind `QR_INVALID`.
 *
 * Slug uniqueness: the schema enforces `@@unique([tenantId, slug])`, so a slug is
 * unique per tenant, not globally. Resolution is therefore a `runUnscoped`
 * `findFirst` on `{ slug, status: PUBLISHED }` rather than a `findUnique` — two
 * tenants publishing the same slug is an admin-facing collision (surfaced when
 * they pick the slug in the CMS, S9-02), not something this read guesses at.
 */

import {
  type BrewsyncClient,
  runUnscoped,
  runWithTenantContext,
} from '@brewsync/db'
import { notFound } from '../http-error.js'
import { FeatureService } from './feature.service.js'
import { ProductService } from './product.service.js'
import { PriceService } from './price.service.js'

/** A landing page resolved from its public slug — the trusted ids downstream ops use. */
export interface ResolvedLandingPage {
  tenantId: string
  outletId: string | null
  pageId: string
}

/** A CATALOG section's stored selection (`content`): which products/categories to show. */
interface CatalogContent {
  categoryIds?: string[]
  productIds?: string[]
}

export class PublicLandingService {
  constructor(private readonly db: BrewsyncClient) {}

  /**
   * Maps a public slug to its PUBLISHED landing page. The single sanctioned
   * `runUnscoped` read in this flow (mirrors the outbox worker / QR resolve): no
   * tenant context is available yet. A missing page OR a draft both throw the
   * opaque `LANDING_INVALID` — the caller never learns which.
   */
  async resolveSlug(slug: string): Promise<ResolvedLandingPage> {
    const page = await runUnscoped(() =>
      this.db.landingPage.findFirst({
        where: { slug, status: 'PUBLISHED' },
        select: { id: true, tenantId: true, outletId: true },
      })
    )
    if (!page) {
      throw notFound('LANDING_INVALID', 'This page is not available.')
    }
    return { tenantId: page.tenantId, outletId: page.outletId, pageId: page.id }
  }

  /**
   * Builds the public view of a resolved page: page meta, its outlet name, and
   * sections in position order. Binds the resolved tenant/outlet context, then
   * asserts `landingPage` is on (else the same opaque 404, so a disabled feature
   * does not leak). CATALOG sections resolve their selection against live master
   * products. Reads are scoped normally by the extension once context is bound.
   */
  async buildPage(resolved: ResolvedLandingPage) {
    return runWithTenantContext(
      { tenantId: resolved.tenantId, outletId: resolved.outletId ?? undefined },
      async () => {
        await this.assertLandingEnabled()

        const page = await this.db.landingPage.findFirst({
          where: { id: resolved.pageId },
          select: {
            slug: true,
            title: true,
            description: true,
            theme: true,
            orderingEnabled: true,
            outlet: { select: { name: true } },
            sections: {
              where: { isVisible: true },
              orderBy: { position: 'asc' },
              select: { id: true, type: true, title: true, content: true },
            },
          },
        })
        // The GUC is bound now, so a page from another tenant would already be
        // invisible — but the feature assertion above can't run without a page,
        // and resolveSlug proved it exists, so a null here means it vanished
        // between calls. Treat it as the same opaque 404.
        if (!page) {
          throw notFound('LANDING_INVALID', 'This page is not available.')
        }

        // Resolve CATALOG sections' live product data in one pass. Non-catalog
        // sections pass their content through untouched for the renderer. JSON
        // columns are cast to `unknown` at the boundary so the public return
        // shape doesn't leak Prisma's JsonValue runtime type (TS2742).
        const sections = await Promise.all(
          page.sections.map(async (section) => {
            if (section.type !== 'CATALOG') {
              return {
                id: section.id,
                type: section.type,
                title: section.title,
                content: section.content as unknown,
              }
            }
            return {
              id: section.id,
              type: section.type,
              title: section.title,
              content: section.content as unknown,
              catalog: await this.resolveCatalog(
                (section.content ?? {}) as CatalogContent,
                resolved.outletId
              ),
            }
          })
        )

        return {
          page: {
            slug: page.slug,
            title: page.title,
            description: page.description,
            theme: page.theme as unknown,
            orderingEnabled: page.orderingEnabled,
          },
          outlet: page.outlet ? { name: page.outlet.name } : null,
          sections,
        }
      }
    )
  }

  /**
   * Resolves a CATALOG section's stored selection to live products, each with its
   * purchasable variants and a resolved price. Pulls from master via
   * `ProductService.list()` (active products only), filters to the section's
   * `productIds` / `categoryIds` if given (empty selection → the whole active
   * catalog), then attaches variant prices for this outlet — the same
   * `salesMethod: null` resolution a dine-in staff order uses. Deactivated
   * products never appear, so the page silently reflects master edits (§17.1).
   */
  private async resolveCatalog(content: CatalogContent, outletId: string | null) {
    const products = await new ProductService(this.db).list()

    const productIds = new Set(content.productIds ?? [])
    const categoryIds = new Set(content.categoryIds ?? [])
    const selected =
      productIds.size === 0 && categoryIds.size === 0
        ? products
        : products.filter(
            (p) => productIds.has(p.id) || (p.categoryId != null && categoryIds.has(p.categoryId))
          )

    if (selected.length === 0) return []

    const variants = await this.db.productVariant.findMany({
      where: { productId: { in: selected.map((p) => p.id) }, isActive: true },
      select: { id: true, productId: true, name: true, basePrice: true },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
    })

    const prices = await new PriceService(this.db).resolveMany(
      variants.map((v) => v.id),
      { outletId: outletId ?? undefined, salesMethod: null }
    )

    const variantsByProduct = new Map<string, Array<{ variantId: string; name: string; price: string }>>()
    for (const v of variants) {
      const list = variantsByProduct.get(v.productId) ?? []
      list.push({
        variantId: v.id,
        name: v.name,
        // Money is minor units (BigInt); serialise to string for JSON transport.
        price: (prices.get(v.id)?.price ?? v.basePrice).toString(),
      })
      variantsByProduct.set(v.productId, list)
    }

    // A product with no active variant is not purchasable — drop it, like QR.
    return selected
      .map((p) => ({
        productId: p.id,
        name: p.name,
        categoryName: p.category?.name ?? null,
        coverImageUrl: p.images[0]?.url ?? null,
        variants: variantsByProduct.get(p.id) ?? [],
      }))
      .filter((p) => p.variants.length > 0)
  }

  /** Asserts `landingPage` is enabled; a disabled feature is masked as `LANDING_INVALID`. */
  private async assertLandingEnabled(): Promise<void> {
    const enabled = await new FeatureService(this.db).isEnabled('landingPage')
    if (!enabled) {
      throw notFound('LANDING_INVALID', 'This page is not available.')
    }
  }
}
