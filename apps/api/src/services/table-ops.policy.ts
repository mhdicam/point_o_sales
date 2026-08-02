/**
 * Floor-operation policies — S7-03, design §5.4.
 *
 * The pure, DB-free decisions behind transfer / merge / move-item. Kept apart
 * from `OrderService` so the money-touching rules (what survives a merge, which
 * charges follow an item) can be unit-tested without a database.
 *
 * The one deliberate money decision here is the **merge drop policy**: when two
 * orders combine, the absorbed order's *order-level* discount and gratuity are
 * dropped, because they were computed against a subtotal that no longer exists
 * (§6 order discounts apply to the running discounted subtotal, gratuity is a
 * flat add outside the total). Re-hosting them on the survivor would silently
 * change the money. Item-level discounts, by contrast, are attached to a
 * specific line and travel with it — their basis is unchanged by the move.
 */

/** The charge kinds and their line attachment, as read from persisted rows. */
export interface MergeChargeRow {
  kind: 'DISCOUNT' | 'SERVICE_CHARGE' | 'TAX' | 'ROUNDING' | 'GRATUITY'
  label: string
  /** Signed minor units — decimal string on the wire, kept as string here (DB-free). */
  amount: string
  /** Set for an item discount; null for an order-level charge. */
  orderItemId: string | null
}

/** A dropped charge, surfaced to the caller so the UI can warn the cashier. */
export interface MergeWarning {
  kind: 'ORDER_DISCOUNT_DROPPED' | 'GRATUITY_DROPPED'
  label: string
  /** The signed minor-unit amount that was dropped (decimal string). */
  amount: string
}

/**
 * Classifies an absorbed order's charge rows for a merge.
 *
 * Item discounts (`orderItemId` set) travel with their line — the caller
 * reparents them. Order-level discounts and gratuity are dropped and returned as
 * warnings. Derived charges (SERVICE_CHARGE / TAX / ROUNDING) are ignored: they
 * are recomputed on the survivor from scratch, never carried.
 */
export function classifyMergeCharges(charges: readonly MergeChargeRow[]): {
  /** orderItemId → the item-discount rows to reparent onto the survivor. */
  itemDiscountIds: string[]
  /** Order-level discount + gratuity that are dropped, for the warning banner. */
  warnings: MergeWarning[]
} {
  const itemDiscountIds: string[] = []
  const warnings: MergeWarning[] = []

  for (const c of charges) {
    if (c.kind === 'DISCOUNT' && c.orderItemId !== null) {
      itemDiscountIds.push(c.orderItemId)
      continue
    }
    if (c.kind === 'DISCOUNT' && c.orderItemId === null) {
      warnings.push({ kind: 'ORDER_DISCOUNT_DROPPED', label: c.label, amount: c.amount })
      continue
    }
    if (c.kind === 'GRATUITY') {
      warnings.push({ kind: 'GRATUITY_DROPPED', label: c.label, amount: c.amount })
    }
    // SERVICE_CHARGE / TAX / ROUNDING are derived — recomputed, never carried.
  }

  return { itemDiscountIds, warnings }
}
