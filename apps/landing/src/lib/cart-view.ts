/**
 * Cart / menu view-models — the pure seam between the QR wire types and React
 * (mirrors apps/pos/src/lib/order-view.ts). Takes the menu payload + the
 * client-side cart array and returns render-ready structures. It calls no API
 * and holds no state.
 *
 * Money rule (standard #2): this module NEVER produces an authoritative amount.
 * The order total the customer pays is whatever the server's bill pipeline
 * returns on placement (rendered on the confirmation screen from
 * `order.summary`). What this module produces is a *display preview* of line and
 * cart subtotals so the customer sees running numbers while building the cart.
 * Those previews are exact integer arithmetic on the server-provided per-unit
 * price via `Money.mulQty` / `Money.sum` (BigInt — no float, no rounding), then
 * formatted with `Money.format`. Because there is no percentage or rounding
 * step, the preview cannot silently disagree with the server on the item lines;
 * taxes/charges/rounding are added by the server and only ever appear post-order.
 */

import { Money } from '@brewsync/shared'
import type { QrMenuResponse, QrMenuVariant, QrOrderItemInput } from './qr-types.ts'

/** A menu variant grouped under its product, with display metadata attached. */
export interface MenuProductView {
  productId: string
  name: string
  categoryName: string | null
  coverImageUrl: string | null
  variants: QrMenuVariant[]
}

/**
 * The menu grouped for rendering: variants nested under their product, in the
 * server's order. A variant whose product is missing from `products` is dropped
 * defensively (the menu endpoint always pairs them, but the view never crashes
 * on a mismatch).
 */
export function buildMenuView(menu: QrMenuResponse): MenuProductView[] {
  const byProduct = new Map<string, MenuProductView>()
  const order: string[] = []

  for (const p of menu.products) {
    if (byProduct.has(p.productId)) continue
    byProduct.set(p.productId, {
      productId: p.productId,
      name: p.name,
      categoryName: p.categoryName,
      coverImageUrl: p.coverImageUrl,
      variants: [],
    })
    order.push(p.productId)
  }

  for (const v of menu.variants) {
    byProduct.get(v.productId)?.variants.push(v)
  }

  // Only surface products that actually have a purchasable variant.
  return order.map((id) => byProduct.get(id)!).filter((p) => p.variants.length > 0)
}

/** One cart line joined to its menu variant, with a formatted price preview. */
export interface CartLineView {
  variantId: string
  name: string
  qty: number
  /** Per-unit price, formatted for display. */
  unitPriceLabel: string
  /** unit price × qty, formatted for display (exact integer, preview only). */
  lineTotalLabel: string
}

/** The cart shaped for the bottom-sheet: joined lines + a subtotal preview. */
export interface CartView {
  lines: CartLineView[]
  /** Total item count (sum of qty) — drives the sheet's badge. */
  itemCount: number
  /** Sum of line previews, formatted. NOT the payable total (server owns that). */
  subtotalLabel: string
  isEmpty: boolean
}

/**
 * Joins cart entries to menu variants and formats line + subtotal previews. A
 * cart entry whose variant is no longer in the menu is dropped (defensive — the
 * menu could refresh mid-session). Quantities ≤ 0 are treated as absent.
 */
export function buildCartView(menu: QrMenuResponse, cart: readonly QrOrderItemInput[]): CartView {
  const variants = new Map<string, QrMenuVariant>(menu.variants.map((v) => [v.variantId, v]))

  const lines: CartLineView[] = []
  const lineTotals: bigint[] = []
  let itemCount = 0

  for (const entry of cart) {
    if (entry.qty <= 0) continue
    const variant = variants.get(entry.variantId)
    if (!variant) continue

    const unit = Money.of(variant.price)
    const lineTotal = Money.mulQty(unit, entry.qty)
    lineTotals.push(lineTotal)
    itemCount += entry.qty

    lines.push({
      variantId: entry.variantId,
      name: variant.name,
      qty: entry.qty,
      unitPriceLabel: Money.format(unit),
      lineTotalLabel: Money.format(lineTotal),
    })
  }

  return {
    lines,
    itemCount,
    subtotalLabel: Money.format(Money.sum(lineTotals)),
    isEmpty: lines.length === 0,
  }
}

/**
 * Immutably set the quantity of a variant in the cart. `qty <= 0` removes the
 * line. Keeps the cart as a flat `{ variantId, qty }[]` (the shape POSTed to the
 * order endpoint), so no transform is needed at checkout.
 */
export function setCartQty(
  cart: readonly QrOrderItemInput[],
  variantId: string,
  qty: number
): QrOrderItemInput[] {
  const next = cart.filter((e) => e.variantId !== variantId)
  if (qty > 0) next.push({ variantId, qty })
  return next
}

/** Current quantity of a variant in the cart (0 if absent). */
export function cartQtyOf(cart: readonly QrOrderItemInput[], variantId: string): number {
  return cart.find((e) => e.variantId === variantId)?.qty ?? 0
}
