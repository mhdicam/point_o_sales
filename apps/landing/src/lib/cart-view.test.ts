import { describe, it, expect } from 'vitest'
import { buildMenuView, buildCartView, setCartQty, cartQtyOf } from './cart-view.ts'
import type { QrMenuResponse, QrOrderItemInput } from './qr-types.ts'

/**
 * The QR menu is grouped by product with variants nested; prices are minor-unit
 * decimal strings. IDR (minorUnitDigits 0) so `Money.format` renders whole
 * rupiah — the previews below assert exact integer arithmetic, never a float.
 */
const MENU: QrMenuResponse = {
  table: { name: 'Meja 5' },
  outlet: { id: 'outlet-1' },
  products: [
    { productId: 'p-coffee', name: 'Kopi Susu', categoryName: 'Minuman', coverImageUrl: null },
    { productId: 'p-cake', name: 'Cheesecake', categoryName: 'Dessert', coverImageUrl: 'x.jpg' },
    // A product with no variant in the payload — must not surface.
    { productId: 'p-empty', name: 'Kosong', categoryName: null, coverImageUrl: null },
  ],
  variants: [
    { variantId: 'v-coffee-r', productId: 'p-coffee', name: 'Reguler', price: '22000' },
    { variantId: 'v-coffee-l', productId: 'p-coffee', name: 'Large', price: '27000' },
    { variantId: 'v-cake', productId: 'p-cake', name: 'Slice', price: '35000' },
  ],
}

describe('buildMenuView', () => {
  it('groups variants under their product in server order', () => {
    const view = buildMenuView(MENU)
    expect(view.map((p) => p.productId)).toEqual(['p-coffee', 'p-cake'])
    expect(view[0]?.variants.map((v) => v.variantId)).toEqual(['v-coffee-r', 'v-coffee-l'])
    expect(view[1]?.categoryName).toBe('Dessert')
  })

  it('drops a product that has no purchasable variant', () => {
    const view = buildMenuView(MENU)
    expect(view.find((p) => p.productId === 'p-empty')).toBeUndefined()
  })

  it('drops a variant whose product row is missing', () => {
    const orphaned: QrMenuResponse = {
      ...MENU,
      products: [MENU.products[0]!],
      variants: [
        ...MENU.variants.slice(0, 2),
        { variantId: 'v-orphan', productId: 'p-gone', name: 'X', price: '1000' },
      ],
    }
    const view = buildMenuView(orphaned)
    expect(view).toHaveLength(1)
    expect(view[0]?.variants).toHaveLength(2)
  })
})

describe('buildCartView', () => {
  it('is empty for an empty cart', () => {
    const view = buildCartView(MENU, [])
    expect(view.isEmpty).toBe(true)
    expect(view.itemCount).toBe(0)
    expect(view.lines).toHaveLength(0)
  })

  it('joins lines and previews line + subtotal via exact integer money', () => {
    const cart: QrOrderItemInput[] = [
      { variantId: 'v-coffee-r', qty: 2 }, // 22000 × 2 = 44000
      { variantId: 'v-cake', qty: 1 }, // 35000
    ]
    const view = buildCartView(MENU, cart)
    expect(view.itemCount).toBe(3)
    expect(view.lines[0]?.lineTotalLabel).toContain('44.000')
    expect(view.lines[0]?.unitPriceLabel).toContain('22.000')
    // Subtotal 79000 — a display preview, not the payable total.
    expect(view.subtotalLabel).toContain('79.000')
    expect(view.isEmpty).toBe(false)
  })

  it('drops a cart entry whose variant left the menu', () => {
    const cart: QrOrderItemInput[] = [
      { variantId: 'v-coffee-r', qty: 1 },
      { variantId: 'v-stale', qty: 3 },
    ]
    const view = buildCartView(MENU, cart)
    expect(view.lines).toHaveLength(1)
    expect(view.itemCount).toBe(1)
  })

  it('ignores non-positive quantities', () => {
    const view = buildCartView(MENU, [{ variantId: 'v-coffee-r', qty: 0 }])
    expect(view.isEmpty).toBe(true)
  })
})

describe('setCartQty / cartQtyOf', () => {
  it('adds, updates, and removes lines immutably', () => {
    let cart: QrOrderItemInput[] = []
    cart = setCartQty(cart, 'v-cake', 2)
    expect(cartQtyOf(cart, 'v-cake')).toBe(2)

    const before = cart
    cart = setCartQty(cart, 'v-cake', 5)
    expect(cartQtyOf(cart, 'v-cake')).toBe(5)
    expect(cart).not.toBe(before) // new array, not mutated

    cart = setCartQty(cart, 'v-cake', 0)
    expect(cartQtyOf(cart, 'v-cake')).toBe(0)
    expect(cart).toHaveLength(0)
  })
})
