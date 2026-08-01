import { describe, expect, it } from 'vitest'
import {
  buildCreatePayload,
  buildUpdatePayload,
  hasErrors,
  validateProductDraft,
  type ProductDraft,
} from './product-form.ts'

function draft(over: Partial<ProductDraft> = {}): ProductDraft {
  return {
    name: 'Latte',
    slug: 'latte',
    description: '',
    categoryId: null,
    fulfillmentType: 'MADE_TO_ORDER',
    variants: [
      { sku: 'LAT-R', name: 'Regular', barcode: '', basePrice: '12.50', isDefault: true, sortOrder: 0 },
    ],
    images: [],
    ...over,
  }
}

describe('validateProductDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(hasErrors(validateProductDraft(draft()))).toBe(false)
  })

  it('requires a name and a valid slug', () => {
    const e = validateProductDraft(draft({ name: '  ', slug: 'Bad Slug' }))
    expect(e.name).toBeDefined()
    expect(e.slug).toBeDefined()
  })

  it('requires at least one variant', () => {
    const e = validateProductDraft(draft({ variants: [] }))
    expect(e.variants).toBeDefined()
  })

  it('requires exactly one default variant', () => {
    const two = draft({
      variants: [
        { sku: 'A', name: 'A', barcode: '', basePrice: '1.00', isDefault: true, sortOrder: 0 },
        { sku: 'B', name: 'B', barcode: '', basePrice: '2.00', isDefault: true, sortOrder: 1 },
      ],
    })
    expect(validateProductDraft(two).variants).toBeDefined()

    const none = draft({
      variants: [
        { sku: 'A', name: 'A', barcode: '', basePrice: '1.00', isDefault: false, sortOrder: 0 },
      ],
    })
    expect(validateProductDraft(none).variants).toBeDefined()
  })

  it('flags per-variant sku/name/price problems by index', () => {
    const e = validateProductDraft(
      draft({
        variants: [
          { sku: '', name: '', barcode: '', basePrice: '1.999', isDefault: true, sortOrder: 0 },
        ],
      })
    )
    expect(e.variantRows[0]?.sku).toBeDefined()
    expect(e.variantRows[0]?.name).toBeDefined()
    expect(e.variantRows[0]?.basePrice).toBeDefined()
  })

  it('requires exactly one cover when images exist', () => {
    const none = draft({
      images: [{ url: 'https://x/y.png', alt: '', isCover: false, sortOrder: 0 }],
    })
    expect(validateProductDraft(none).images).toBeDefined()

    const many = draft({
      images: [
        { url: 'https://x/a.png', alt: '', isCover: true, sortOrder: 0 },
        { url: 'https://x/b.png', alt: '', isCover: true, sortOrder: 1 },
      ],
    })
    expect(validateProductDraft(many).images).toBeDefined()
  })
})

describe('buildCreatePayload', () => {
  it('trims, nulls empties, and converts price to minor units', () => {
    const payload = buildCreatePayload(
      draft({ description: '  rich  ', variants: [
        { sku: ' LAT ', name: ' Reg ', barcode: '', basePrice: '12.50', isDefault: true, sortOrder: 0 },
      ] })
    )
    expect(payload.description).toBe('rich')
    expect(payload.variants[0]).toMatchObject({
      sku: 'LAT',
      name: 'Reg',
      barcode: null,
      basePrice: '1250',
      isDefault: true,
    })
    expect(payload.images).toBeUndefined()
  })

  it('omits basePrice when the field is blank', () => {
    const payload = buildCreatePayload(
      draft({ variants: [
        { sku: 'A', name: 'A', barcode: '', basePrice: '', isDefault: true, sortOrder: 0 },
      ] })
    )
    expect(payload.variants[0]).not.toHaveProperty('basePrice')
  })

  it('includes images with a cover flag when present', () => {
    const payload = buildCreatePayload(
      draft({ images: [{ url: 'https://x/y.png', alt: 'y', isCover: true, sortOrder: 0 }] })
    )
    expect(payload.images).toHaveLength(1)
    expect(payload.images![0]).toMatchObject({ url: 'https://x/y.png', isCover: true })
  })
})

describe('buildUpdatePayload', () => {
  it('returns only product-level fields', () => {
    const payload = buildUpdatePayload(draft({ description: '' }))
    expect(payload).toEqual({
      name: 'Latte',
      slug: 'latte',
      description: null,
      categoryId: null,
      fulfillmentType: 'MADE_TO_ORDER',
    })
  })
})
