/**
 * Product form logic — pure validation + payload assembly for the create/edit
 * product form. Mirrors the backend's createProductSchema and its three service
 * invariants (≥1 variant, exactly one default variant, ≤1 cover image) so the
 * UI can surface errors inline before POSTing. The backend re-validates
 * everything — this is UX, not the security/consistency boundary.
 */

import type { FulfillmentType } from '@brewsync/shared'
import { inputToMinor } from './money-input.ts'

export interface VariantDraft {
  /** Present when editing an existing variant; absent for a new one. */
  id?: string
  sku: string
  name: string
  barcode: string
  /** Editable major-unit string, e.g. "12.50". */
  basePrice: string
  isDefault: boolean
  sortOrder: number
}

export interface ImageDraft {
  id?: string
  url: string
  alt: string
  isCover: boolean
  sortOrder: number
}

export interface ProductDraft {
  name: string
  slug: string
  description: string
  categoryId: string | null
  fulfillmentType: FulfillmentType
  variants: VariantDraft[]
  images: ImageDraft[]
}

const SLUG_RE = /^[a-z0-9-]+$/

export interface ProductFormErrors {
  name?: string
  slug?: string
  variants?: string
  /** Per-variant errors keyed by array index. */
  variantRows: Record<number, { sku?: string; name?: string; basePrice?: string }>
  images?: string
}

export function validateProductDraft(
  draft: ProductDraft,
  minorUnitDigits = 2
): ProductFormErrors {
  const errors: ProductFormErrors = { variantRows: {} }

  if (draft.name.trim() === '') errors.name = 'Name is required'

  if (draft.slug.trim() === '') {
    errors.slug = 'Slug is required'
  } else if (!SLUG_RE.test(draft.slug)) {
    errors.slug = 'Lowercase letters, numbers and hyphens only'
  }

  if (draft.variants.length === 0) {
    errors.variants = 'A product needs at least one variant'
  } else {
    const defaults = draft.variants.filter((v) => v.isDefault).length
    if (defaults !== 1) {
      errors.variants = 'Exactly one variant must be the default'
    }
    draft.variants.forEach((v, i) => {
      const row: { sku?: string; name?: string; basePrice?: string } = {}
      if (v.sku.trim() === '') row.sku = 'SKU is required'
      if (v.name.trim() === '') row.name = 'Name is required'
      if (v.basePrice.trim() !== '' && inputToMinor(v.basePrice, minorUnitDigits) === null) {
        row.basePrice = 'Invalid price'
      }
      if (Object.keys(row).length > 0) errors.variantRows[i] = row
    })
  }

  const covers = draft.images.filter((img) => img.isCover).length
  if (covers > 1) errors.images = 'Only one image can be the cover'
  if (draft.images.length > 0 && covers === 0) {
    errors.images = 'One image must be marked as the cover'
  }

  return errors
}

export function hasErrors(errors: ProductFormErrors): boolean {
  return (
    errors.name !== undefined ||
    errors.slug !== undefined ||
    errors.variants !== undefined ||
    errors.images !== undefined ||
    Object.keys(errors.variantRows).length > 0
  )
}

// ---- Payload builders (assume the draft already validated) ----

export interface CreateProductPayload {
  name: string
  slug: string
  description?: string | null
  categoryId?: string | null
  fulfillmentType: FulfillmentType
  variants: Array<{
    sku: string
    name: string
    barcode?: string | null
    basePrice?: string
    isDefault: boolean
    sortOrder: number
  }>
  images?: Array<{
    url: string
    alt?: string | null
    isCover: boolean
    sortOrder: number
  }>
}

export function buildCreatePayload(
  draft: ProductDraft,
  minorUnitDigits = 2
): CreateProductPayload {
  const payload: CreateProductPayload = {
    name: draft.name.trim(),
    slug: draft.slug.trim(),
    description: draft.description.trim() === '' ? null : draft.description.trim(),
    categoryId: draft.categoryId,
    fulfillmentType: draft.fulfillmentType,
    variants: draft.variants.map((v, i) => {
      const minor = inputToMinor(v.basePrice, minorUnitDigits)
      return {
        sku: v.sku.trim(),
        name: v.name.trim(),
        barcode: v.barcode.trim() === '' ? null : v.barcode.trim(),
        ...(minor !== null ? { basePrice: minor } : {}),
        isDefault: v.isDefault,
        sortOrder: v.sortOrder || i,
      }
    }),
  }

  if (draft.images.length > 0) {
    payload.images = draft.images.map((img, i) => ({
      url: img.url.trim(),
      alt: img.alt.trim() === '' ? null : img.alt.trim(),
      isCover: img.isCover,
      sortOrder: img.sortOrder || i,
    }))
  }

  return payload
}

/** Product-level fields the PUT /products/:id endpoint accepts. */
export interface UpdateProductPayload {
  name: string
  slug: string
  description: string | null
  categoryId: string | null
  fulfillmentType: FulfillmentType
}

export function buildUpdatePayload(draft: ProductDraft): UpdateProductPayload {
  return {
    name: draft.name.trim(),
    slug: draft.slug.trim(),
    description: draft.description.trim() === '' ? null : draft.description.trim(),
    categoryId: draft.categoryId,
    fulfillmentType: draft.fulfillmentType,
  }
}
