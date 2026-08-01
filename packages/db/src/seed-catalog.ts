/**
 * Demo master-product catalog — S3-06, design §3.
 *
 * One catalog per demo tenant so "one core, many shapes" is visible in the UI
 * without anyone configuring anything. The difference between the F&B, retail
 * and service demo is entirely in the data below — fulfillmentType, unit
 * dimensions, whether modifier groups or barcodes exist at all — never in a
 * branch. The seeder underneath has no idea which vertical it is writing.
 *
 * Lives in src/ rather than prisma/ because prisma/seed.ts sits outside the
 * package tsconfig `include` and is therefore never typechecked; this half is.
 *
 * Written with the unscoped client, so `tenantId` is passed explicitly — the one
 * layer where that is legitimate (CLAUDE.md standard #1 exempts packages/db).
 */

import { UNIT_FACTOR_SCALE } from '@brewsync/shared'
import type { FulfillmentType, PrismaClient, UnitDimension } from '../generated/client/index.js'

interface SeedUnit {
  code: string
  name: string
  dimension: UnitDimension
  /** Omit for the base unit of its dimension — base units carry factor = scale. */
  baseCode?: string
  /** How many base units make one of these. Required when `baseCode` is set. */
  perBase?: bigint
}

interface SeedCategory {
  slug: string
  name: string
  parentSlug?: string
  /** Inherited by products that do not override it (design §3.1). */
  defaultTaxRateBp?: number
  reportGroup?: string
}

interface SeedVariant {
  sku: string
  name: string
  /** Minor units (standard #2). */
  basePrice: bigint
  barcode?: string
  /** Overrides the product's type — the deliberate mixed case (schema §ProductVariant). */
  fulfillmentType?: FulfillmentType
  sellUnitCode?: string
  stockUnitCode?: string
  serviceDurationMin?: number
}

interface SeedImage {
  url: string
  alt?: string
}

interface SeedProduct {
  slug: string
  name: string
  description?: string
  categorySlug?: string
  fulfillmentType: FulfillmentType
  images?: SeedImage[]
  modifierGroups?: string[]
  variants: SeedVariant[]
}

interface SeedModifier {
  name: string
  /** Signed: a bring-your-own-cup rebate is a negative delta, not a discount row. */
  priceDelta: bigint
  isDefault?: boolean
}

interface SeedModifierGroup {
  name: string
  minSelect?: number
  maxSelect?: number
  isRequired?: boolean
  modifiers: SeedModifier[]
}

interface SeedPriceList {
  name: string
  /** Omit for tenant-wide. */
  outletCode?: string
  /** Plain string until SalesMethod lands in S7. */
  salesMethod?: string
  priority?: number
  items: { sku: string; price: bigint }[]
}

export interface SeedCatalog {
  units: SeedUnit[]
  categories: SeedCategory[]
  modifierGroups: SeedModifierGroup[]
  products: SeedProduct[]
  priceLists: SeedPriceList[]
}

const COUNT: UnitDimension = 'COUNT'
const WEIGHT: UnitDimension = 'WEIGHT'
const VOLUME: UnitDimension = 'VOLUME'

/**
 * F&B — brewed drinks are MADE_TO_ORDER, and one product deliberately mixes a
 * brewed variant with a bagged-bean STOCKED variant (the case the schema comment
 * on ProductVariant.fulfillmentType exists for). Modifier groups only appear
 * here because PRESET_DEFAULTS.FNB.modifiers is the only preset with them on.
 */
const KOPI_NUSANTARA: SeedCatalog = {
  units: [
    { code: 'pcs', name: 'Pieces', dimension: COUNT },
    { code: 'g', name: 'Gram', dimension: WEIGHT },
    { code: 'kg', name: 'Kilogram', dimension: WEIGHT, baseCode: 'g', perBase: 1000n },
    { code: 'ml', name: 'Mililiter', dimension: VOLUME },
    { code: 'l', name: 'Liter', dimension: VOLUME, baseCode: 'ml', perBase: 1000n },
  ],
  categories: [
    { slug: 'minuman', name: 'Minuman', defaultTaxRateBp: 1000, reportGroup: 'Beverage' },
    { slug: 'minuman-kopi', name: 'Kopi', parentSlug: 'minuman', reportGroup: 'Beverage' },
    { slug: 'minuman-non-kopi', name: 'Non-Kopi', parentSlug: 'minuman', reportGroup: 'Beverage' },
    { slug: 'makanan', name: 'Makanan', defaultTaxRateBp: 1000, reportGroup: 'Food' },
    { slug: 'biji-kemasan', name: 'Biji Kopi Kemasan', reportGroup: 'Retail' },
  ],
  modifierGroups: [
    {
      name: 'Ukuran',
      minSelect: 1,
      maxSelect: 1,
      isRequired: true,
      modifiers: [
        { name: 'Regular', priceDelta: 0n, isDefault: true },
        { name: 'Large', priceDelta: 5_000n },
      ],
    },
    {
      name: 'Level Gula',
      minSelect: 1,
      maxSelect: 1,
      isRequired: true,
      modifiers: [
        { name: 'Normal', priceDelta: 0n, isDefault: true },
        { name: 'Less Sugar', priceDelta: 0n },
        { name: 'No Sugar', priceDelta: 0n },
      ],
    },
    {
      name: 'Suhu',
      minSelect: 1,
      maxSelect: 1,
      isRequired: true,
      modifiers: [
        { name: 'Dingin', priceDelta: 0n, isDefault: true },
        { name: 'Panas', priceDelta: 0n },
      ],
    },
    {
      name: 'Ekstra',
      minSelect: 0,
      maxSelect: 3,
      modifiers: [
        { name: 'Extra Shot', priceDelta: 8_000n },
        { name: 'Extra Boba', priceDelta: 6_000n },
        // Negative delta: proof the column is signed and needs no separate concept.
        { name: 'Bawa Tumbler Sendiri', priceDelta: -2_000n },
      ],
    },
  ],
  products: [
    {
      slug: 'es-kopi-susu',
      name: 'Es Kopi Susu',
      description: 'Espresso, susu segar, gula aren.',
      categorySlug: 'minuman-kopi',
      fulfillmentType: 'MADE_TO_ORDER',
      images: [
        { url: '/seed/kopi/es-kopi-susu-1.jpg', alt: 'Es kopi susu gelas plastik' },
        { url: '/seed/kopi/es-kopi-susu-2.jpg', alt: 'Es kopi susu dari atas' },
        { url: '/seed/kopi/es-kopi-susu-3.jpg', alt: 'Proses tuang gula aren' },
      ],
      modifierGroups: ['Ukuran', 'Level Gula', 'Ekstra'],
      variants: [
        { sku: 'KN-EKS-R', name: 'Regular', basePrice: 22_000n, sellUnitCode: 'pcs' },
        { sku: 'KN-EKS-L', name: 'Large', basePrice: 27_000n, sellUnitCode: 'pcs' },
      ],
    },
    {
      slug: 'americano',
      name: 'Americano',
      categorySlug: 'minuman-kopi',
      fulfillmentType: 'MADE_TO_ORDER',
      modifierGroups: ['Ukuran', 'Suhu', 'Ekstra'],
      variants: [
        { sku: 'KN-AMR-R', name: 'Regular', basePrice: 20_000n, sellUnitCode: 'pcs' },
        { sku: 'KN-AMR-L', name: 'Large', basePrice: 25_000n, sellUnitCode: 'pcs' },
      ],
    },
    {
      slug: 'matcha-latte',
      name: 'Matcha Latte',
      categorySlug: 'minuman-non-kopi',
      fulfillmentType: 'MADE_TO_ORDER',
      modifierGroups: ['Ukuran', 'Level Gula', 'Suhu'],
      variants: [{ sku: 'KN-MTC-R', name: 'Regular', basePrice: 26_000n, sellUnitCode: 'pcs' }],
    },
    {
      slug: 'croissant-butter',
      name: 'Croissant Butter',
      description: 'Datang dari baker tiap pagi, dihitung stok per potong.',
      categorySlug: 'makanan',
      // A display-case pastry is stock-tracked even inside an F&B tenant.
      fulfillmentType: 'STOCKED',
      variants: [
        {
          sku: 'KN-CRS',
          name: 'Satuan',
          basePrice: 18_000n,
          sellUnitCode: 'pcs',
          stockUnitCode: 'pcs',
        },
      ],
    },
    {
      slug: 'kopi-house-blend',
      name: 'House Blend',
      description: 'Satu produk, dua cara jual: diseduh di tempat atau dibawa pulang.',
      categorySlug: 'biji-kemasan',
      fulfillmentType: 'MADE_TO_ORDER',
      variants: [
        { sku: 'KN-HB-BREW', name: 'Seduh V60', basePrice: 28_000n, sellUnitCode: 'pcs' },
        {
          sku: 'KN-HB-BEAN-1KG',
          name: 'Biji 1 kg',
          basePrice: 190_000n,
          // The override the schema comment exists for: sold as goods, not brewed.
          fulfillmentType: 'STOCKED',
          // Sell in kg, deduct stock in g — conversion inside one dimension.
          sellUnitCode: 'kg',
          stockUnitCode: 'g',
        },
      ],
    },
  ],
  priceLists: [
    {
      name: 'Harga Dine-In',
      salesMethod: 'DINE_IN',
      priority: 0,
      items: [{ sku: 'KN-EKS-R', price: 24_000n }],
    },
    {
      // More specific (outlet + method) and higher priority, so the resolver has
      // something real to rank against the tenant-wide list above.
      name: 'Promo Takeaway PST',
      outletCode: 'PST',
      salesMethod: 'TAKEAWAY',
      priority: 10,
      items: [
        { sku: 'KN-EKS-R', price: 20_000n },
        { sku: 'KN-AMR-R', price: 18_000n },
      ],
    },
  ],
}

/**
 * Retail — everything is STOCKED and everything has a barcode (the only preset
 * with `barcode: true`). No modifier groups exist at all, which is the point:
 * the feature is absent from the data, not hidden by an `if`.
 */
const TOKO_SERBA_ADA: SeedCatalog = {
  units: [
    { code: 'pcs', name: 'Pieces', dimension: COUNT },
    { code: 'dus', name: 'Dus (24 pcs)', dimension: COUNT, baseCode: 'pcs', perBase: 24n },
    { code: 'g', name: 'Gram', dimension: WEIGHT },
    { code: 'kg', name: 'Kilogram', dimension: WEIGHT, baseCode: 'g', perBase: 1000n },
  ],
  categories: [
    {
      slug: 'minuman-kemasan',
      name: 'Minuman Kemasan',
      defaultTaxRateBp: 1100,
      reportGroup: 'Beverage',
    },
    { slug: 'makanan-ringan', name: 'Makanan Ringan', defaultTaxRateBp: 1100, reportGroup: 'Snack' },
    { slug: 'sembako', name: 'Sembako', defaultTaxRateBp: 1100, reportGroup: 'Grocery' },
  ],
  modifierGroups: [],
  products: [
    {
      slug: 'air-mineral-600ml',
      name: 'Air Mineral 600 ml',
      categorySlug: 'minuman-kemasan',
      fulfillmentType: 'STOCKED',
      images: [
        { url: '/seed/retail/air-mineral-1.jpg', alt: 'Botol air mineral 600 ml' },
        { url: '/seed/retail/air-mineral-2.jpg', alt: 'Dus air mineral isi 24' },
      ],
      variants: [
        {
          sku: 'TSA-AM-600',
          name: 'Botol',
          basePrice: 4_000n,
          barcode: '8991002100015',
          sellUnitCode: 'pcs',
          stockUnitCode: 'pcs',
        },
        {
          sku: 'TSA-AM-600-DUS',
          name: 'Dus (24 botol)',
          basePrice: 90_000n,
          barcode: '8991002100022',
          // Sell by the box, keep stock by the bottle.
          sellUnitCode: 'dus',
          stockUnitCode: 'pcs',
        },
      ],
    },
    {
      slug: 'keripik-kentang',
      name: 'Keripik Kentang',
      categorySlug: 'makanan-ringan',
      fulfillmentType: 'STOCKED',
      variants: [
        {
          sku: 'TSA-KK-68',
          name: '68 g',
          basePrice: 12_000n,
          barcode: '8992761140015',
          sellUnitCode: 'pcs',
          stockUnitCode: 'pcs',
        },
      ],
    },
    {
      slug: 'beras-premium',
      name: 'Beras Premium',
      categorySlug: 'sembako',
      fulfillmentType: 'STOCKED',
      variants: [
        {
          sku: 'TSA-BR-5KG',
          name: 'Karung 5 kg',
          basePrice: 78_000n,
          barcode: '8998009090011',
          sellUnitCode: 'kg',
          stockUnitCode: 'g',
        },
      ],
    },
    {
      slug: 'gula-pasir',
      name: 'Gula Pasir 1 kg',
      categorySlug: 'sembako',
      fulfillmentType: 'STOCKED',
      variants: [
        {
          sku: 'TSA-GP-1KG',
          name: '1 kg',
          basePrice: 15_500n,
          barcode: '8998009090028',
          sellUnitCode: 'kg',
          stockUnitCode: 'g',
        },
      ],
    },
  ],
  priceLists: [
    {
      name: 'Harga Grosir',
      outletCode: 'TSA',
      priority: 5,
      items: [{ sku: 'TSA-AM-600-DUS', price: 84_000n }],
    },
  ],
}

/**
 * Service — SERVICE variants carry serviceDurationMin, which is what a time slot
 * is booked against later (S8). One STOCKED product sits alongside them: a
 * barbershop that also sells pomade is the same mixed case as the cafe.
 */
const BARBERSHOP_RAPI: SeedCatalog = {
  units: [
    { code: 'pcs', name: 'Pieces', dimension: COUNT },
    { code: 'ml', name: 'Mililiter', dimension: VOLUME },
  ],
  categories: [
    { slug: 'layanan', name: 'Layanan', defaultTaxRateBp: 1100, reportGroup: 'Service' },
    { slug: 'layanan-rambut', name: 'Rambut', parentSlug: 'layanan', reportGroup: 'Service' },
    { slug: 'layanan-cukur', name: 'Cukur', parentSlug: 'layanan', reportGroup: 'Service' },
    { slug: 'produk-perawatan', name: 'Produk Perawatan', reportGroup: 'Retail' },
  ],
  modifierGroups: [],
  products: [
    {
      slug: 'potong-rambut',
      name: 'Potong Rambut',
      categorySlug: 'layanan-rambut',
      fulfillmentType: 'SERVICE',
      images: [{ url: '/seed/barber/potong-rambut.jpg', alt: 'Proses potong rambut' }],
      variants: [
        { sku: 'BR-PR-30', name: 'Reguler', basePrice: 50_000n, serviceDurationMin: 30 },
        { sku: 'BR-PR-45', name: 'Premium + Cuci', basePrice: 80_000n, serviceDurationMin: 45 },
      ],
    },
    {
      slug: 'cukur-jenggot',
      name: 'Cukur Jenggot',
      categorySlug: 'layanan-cukur',
      fulfillmentType: 'SERVICE',
      variants: [{ sku: 'BR-CJ-20', name: 'Standar', basePrice: 35_000n, serviceDurationMin: 20 }],
    },
    {
      slug: 'hair-coloring',
      name: 'Hair Coloring',
      categorySlug: 'layanan-rambut',
      fulfillmentType: 'SERVICE',
      variants: [{ sku: 'BR-HC-90', name: 'Full Color', basePrice: 250_000n, serviceDurationMin: 90 }],
    },
    {
      slug: 'pomade-clay',
      name: 'Pomade Clay 100 ml',
      categorySlug: 'produk-perawatan',
      fulfillmentType: 'STOCKED',
      variants: [
        {
          sku: 'BR-PM-100',
          name: '100 ml',
          basePrice: 95_000n,
          sellUnitCode: 'pcs',
          stockUnitCode: 'pcs',
        },
      ],
    },
  ],
  priceLists: [
    {
      name: 'Harga Weekday',
      priority: 0,
      items: [{ sku: 'BR-PR-30', price: 45_000n }],
    },
  ],
}

/** Keyed by tenant slug so prisma/seed.ts stays a loop over its own tenant list. */
export const DEMO_CATALOGS: Record<string, SeedCatalog> = {
  'kopi-nusantara': KOPI_NUSANTARA,
  'toko-serba-ada': TOKO_SERBA_ADA,
  'barbershop-rapi': BARBERSHOP_RAPI,
}

export interface CatalogCounts {
  units: number
  categories: number
  modifierGroups: number
  products: number
  variants: number
  images: number
  priceLists: number
}

/**
 * Idempotent by construction. Models with a natural unique key are upserted with
 * an empty `update` so a re-run never rewrites hand-edited demo data; the four
 * without one (ModifierGroup, Modifier, PriceList, ProductImage) use a
 * find-then-create guard instead.
 *
 * Requires `app.current_tenant` to already be bound for this tenant — RLS is
 * FORCEd, so even the owner role is refused otherwise.
 */
export async function seedMasterCatalog(
  prisma: PrismaClient,
  tenantId: string,
  catalogKey: string
): Promise<CatalogCounts> {
  const catalog = DEMO_CATALOGS[catalogKey]
  if (!catalog) return { units: 0, categories: 0, modifierGroups: 0, products: 0, variants: 0, images: 0, priceLists: 0 }

  const unitIds = new Map<string, string>()
  for (const spec of catalog.units) {
    // A unit with no base IS the base of its dimension, so its factor is the
    // scale itself; derived units multiply up (packages/shared/unit.ts).
    const baseUnitId = spec.baseCode ? unitIds.get(spec.baseCode) : null
    if (spec.baseCode && !baseUnitId) {
      throw new Error(`Seed unit ${spec.code} references unknown base ${spec.baseCode}`)
    }
    const factor = spec.perBase ? spec.perBase * UNIT_FACTOR_SCALE : UNIT_FACTOR_SCALE

    const unit = await prisma.unit.upsert({
      where: { tenantId_code: { tenantId, code: spec.code } },
      update: {},
      create: {
        tenantId,
        code: spec.code,
        name: spec.name,
        dimension: spec.dimension,
        baseUnitId: baseUnitId ?? null,
        factor,
      },
    })
    unitIds.set(spec.code, unit.id)
  }

  const categoryIds = new Map<string, string>()
  for (const [index, spec] of catalog.categories.entries()) {
    const parentId = spec.parentSlug ? categoryIds.get(spec.parentSlug) : null
    if (spec.parentSlug && !parentId) {
      throw new Error(`Seed category ${spec.slug} references unknown parent ${spec.parentSlug}`)
    }

    const category = await prisma.category.upsert({
      where: { tenantId_slug: { tenantId, slug: spec.slug } },
      update: {},
      create: {
        tenantId,
        slug: spec.slug,
        name: spec.name,
        parentId: parentId ?? null,
        sortOrder: index,
        defaultTaxRateBp: spec.defaultTaxRateBp ?? null,
        reportGroup: spec.reportGroup ?? null,
      },
    })
    categoryIds.set(spec.slug, category.id)
  }

  const groupIds = new Map<string, string>()
  for (const [index, spec] of catalog.modifierGroups.entries()) {
    let group = await prisma.modifierGroup.findFirst({ where: { tenantId, name: spec.name } })
    if (!group) {
      group = await prisma.modifierGroup.create({
        data: {
          tenantId,
          name: spec.name,
          minSelect: spec.minSelect ?? 0,
          maxSelect: spec.maxSelect ?? null,
          isRequired: spec.isRequired ?? false,
          sortOrder: index,
        },
      })
    }
    groupIds.set(spec.name, group.id)

    for (const [modIndex, mod] of spec.modifiers.entries()) {
      const existing = await prisma.modifier.findFirst({
        where: { tenantId, groupId: group.id, name: mod.name },
      })
      if (!existing) {
        await prisma.modifier.create({
          data: {
            tenantId,
            groupId: group.id,
            name: mod.name,
            priceDelta: mod.priceDelta,
            isDefault: mod.isDefault ?? false,
            sortOrder: modIndex,
          },
        })
      }
    }
  }

  const variantIds = new Map<string, string>()
  let imageCount = 0

  for (const [index, spec] of catalog.products.entries()) {
    const categoryId = spec.categorySlug ? categoryIds.get(spec.categorySlug) : null
    if (spec.categorySlug && !categoryId) {
      throw new Error(`Seed product ${spec.slug} references unknown category ${spec.categorySlug}`)
    }

    const product = await prisma.product.upsert({
      where: { tenantId_slug: { tenantId, slug: spec.slug } },
      update: {},
      create: {
        tenantId,
        slug: spec.slug,
        name: spec.name,
        description: spec.description ?? null,
        categoryId: categoryId ?? null,
        fulfillmentType: spec.fulfillmentType,
        sortOrder: index,
      },
    })

    for (const [variantIndex, variant] of spec.variants.entries()) {
      const sellUnitId = variant.sellUnitCode ? unitIds.get(variant.sellUnitCode) : null
      const stockUnitId = variant.stockUnitCode ? unitIds.get(variant.stockUnitCode) : null
      if (variant.sellUnitCode && !sellUnitId) {
        throw new Error(`Seed variant ${variant.sku} references unknown unit ${variant.sellUnitCode}`)
      }
      if (variant.stockUnitCode && !stockUnitId) {
        throw new Error(
          `Seed variant ${variant.sku} references unknown unit ${variant.stockUnitCode}`
        )
      }

      const row = await prisma.productVariant.upsert({
        where: { tenantId_sku: { tenantId, sku: variant.sku } },
        update: {},
        create: {
          tenantId,
          productId: product.id,
          sku: variant.sku,
          name: variant.name,
          barcode: variant.barcode ?? null,
          basePrice: variant.basePrice,
          fulfillmentType: variant.fulfillmentType ?? null,
          sellUnitId: sellUnitId ?? null,
          stockUnitId: stockUnitId ?? null,
          serviceDurationMin: variant.serviceDurationMin ?? null,
          // Computed, not declared: exactly one default per product is the
          // invariant product.service enforces, so the data cannot violate it.
          isDefault: variantIndex === 0,
          sortOrder: variantIndex,
        },
      })
      variantIds.set(variant.sku, row.id)
    }

    for (const [imageIndex, image] of (spec.images ?? []).entries()) {
      const existing = await prisma.productImage.findFirst({
        where: { tenantId, productId: product.id, url: image.url },
      })
      if (!existing) {
        await prisma.productImage.create({
          data: {
            tenantId,
            productId: product.id,
            url: image.url,
            alt: image.alt ?? null,
            isCover: imageIndex === 0,
            sortOrder: imageIndex,
          },
        })
        imageCount += 1
      }
    }

    for (const [groupIndex, groupName] of (spec.modifierGroups ?? []).entries()) {
      const groupId = groupIds.get(groupName)
      if (!groupId) {
        throw new Error(`Seed product ${spec.slug} references unknown modifier group ${groupName}`)
      }
      await prisma.productModifierGroup.upsert({
        where: { productId_groupId: { productId: product.id, groupId } },
        update: {},
        create: { tenantId, productId: product.id, groupId, sortOrder: groupIndex },
      })
    }
  }

  for (const spec of catalog.priceLists) {
    let outletId: string | null = null
    if (spec.outletCode) {
      const outlet = await prisma.outlet.findUnique({
        where: { tenantId_code: { tenantId, code: spec.outletCode } },
      })
      if (!outlet) {
        throw new Error(`Seed price list ${spec.name} references unknown outlet ${spec.outletCode}`)
      }
      outletId = outlet.id
    }

    let priceList = await prisma.priceList.findFirst({ where: { tenantId, name: spec.name } })
    if (!priceList) {
      priceList = await prisma.priceList.create({
        data: {
          tenantId,
          name: spec.name,
          outletId,
          salesMethod: spec.salesMethod ?? null,
          priority: spec.priority ?? 0,
        },
      })
    }

    for (const item of spec.items) {
      const variantId = variantIds.get(item.sku)
      if (!variantId) {
        throw new Error(`Seed price list ${spec.name} references unknown SKU ${item.sku}`)
      }
      await prisma.priceListItem.upsert({
        where: { priceListId_variantId: { priceListId: priceList.id, variantId } },
        update: {},
        create: { tenantId, priceListId: priceList.id, variantId, price: item.price },
      })
    }
  }

  return {
    units: catalog.units.length,
    categories: catalog.categories.length,
    modifierGroups: catalog.modifierGroups.length,
    products: catalog.products.length,
    variants: variantIds.size,
    images: imageCount,
    priceLists: catalog.priceLists.length,
  }
}
