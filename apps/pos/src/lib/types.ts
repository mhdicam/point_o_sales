/**
 * Wire types — the shapes the API actually returns.
 *
 * Money and factor fields are `string`, not `number`: the API serializes BigInt
 * as a decimal string (standard #2), and typing them as string keeps the
 * no-float rule enforced by the compiler. Parse with `money()` at the edge only
 * when arithmetic or formatting is needed.
 *
 * These are hand-maintained against the Prisma models + route responses rather
 * than generated, to avoid coupling the FE build to a Prisma client import.
 */

import type { FulfillmentType } from '@brewsync/shared'

// ---- Session / auth ----

export interface AuthUser {
  id: string
  email: string
  name: string
}

export interface MembershipOutlet {
  id: string
  name: string
}

export interface Membership {
  id: string
  tenant: { id: string; name: string; slug: string }
  outlets: MembershipOutlet[]
}

export interface Scope {
  tenantId: string
  outletId?: string
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

// ---- Master data ----

export interface Category {
  id: string
  name: string
  slug: string
  parentId: string | null
  sortOrder: number
  isActive: boolean
  defaultTaxRateBp: number | null
  defaultStationId: string | null
  reportGroup: string | null
}

export type UnitDimension = 'COUNT' | 'WEIGHT' | 'VOLUME' | 'LENGTH' | 'TIME'

export interface Unit {
  id: string
  code: string
  name: string
  dimension: UnitDimension
  baseUnitId: string | null
  /** BigInt scaled by 1e6 — decimal string on the wire. */
  factor: string
  isActive: boolean
}

export interface ProductImage {
  id: string
  url: string
  alt: string | null
  isCover: boolean
  sortOrder: number
}

export interface ProductVariant {
  id: string
  sku: string
  name: string
  barcode: string | null
  /** Minor units — decimal string. */
  basePrice: string
  fulfillmentType: FulfillmentType | null
  sellUnitId: string | null
  stockUnitId: string | null
  serviceDurationMin: number | null
  isDefault: boolean
  isActive: boolean
  sortOrder: number
}

export interface Product {
  id: string
  categoryId: string | null
  name: string
  slug: string
  description: string | null
  fulfillmentType: FulfillmentType
  isActive: boolean
  sortOrder: number
  variants: ProductVariant[]
  images: ProductImage[]
}

/** List endpoint returns a lighter product (variants/images may be summarized). */
export interface ProductListItem {
  id: string
  categoryId: string | null
  name: string
  slug: string
  fulfillmentType: FulfillmentType
  isActive: boolean
  sortOrder: number
  variants: ProductVariant[]
  images: ProductImage[]
}

export interface ModifierOption {
  id: string
  name: string
  /** Signed minor units — decimal string. */
  priceDelta: string
  isDefault: boolean
  isActive: boolean
  sortOrder: number
}

export interface ModifierGroup {
  id: string
  name: string
  minSelect: number
  maxSelect: number | null
  isRequired: boolean
  isActive: boolean
  sortOrder: number
  modifiers: ModifierOption[]
}

export interface PriceList {
  id: string
  name: string
  outletId: string | null
  salesMethod: string | null
  priority: number
  validFrom: string | null
  validTo: string | null
  isActive: boolean
}
