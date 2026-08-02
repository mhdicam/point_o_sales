/**
 * Payment settlement math — S5-01/02/03, design §7.
 *
 * Pure and DB-free, like the bill pipeline: the rules that decide whether a
 * tender is legal, how much change it returns, and whether it settles the bill
 * are the subtle money part of payments, so they live here and are exercised by
 * a table-driven unit test with no fixtures.
 *
 * The model (design §7.1/§7.2):
 *   - A bill settles when SUM(payment.amount) >= bill.total.
 *   - `amount` is what the customer tendered; `changeGiven` is what was handed
 *     back. Net cash into the drawer is `amount - changeGiven`. Both are recorded
 *     (not netted) so the trail is auditable (standard #3).
 *   - Change is only ever cash. A non-cash tender (card/QRIS) that would exceed
 *     the remaining balance is a mistake, not an over-tender — there is no card
 *     change — so it is rejected rather than silently creating change.
 *
 * Every amount is a `bigint` minor unit (standard #2); this module adds no new
 * money math beyond +/− on integers.
 */

/** Inputs describing one tender against a bill. */
export interface TenderInput {
  /** The bill's settle target (minor units). §6 total incl. gratuity. */
  billTotal: bigint
  /** SUM of payment.amount already recorded on this bill, before this tender. */
  priorTendered: bigint
  /** What the customer is handing over now (minor units, positive). */
  amount: bigint
  /** Whether the tender's method contributes to the cash drawer (design §7.5). */
  methodCountsAsCash: boolean
}

export interface TenderResult {
  /** Cash returned to the customer on an over-tender. Zero for exact/under. */
  changeGiven: bigint
  /** Whether this tender brings SUM(amount) to >= billTotal. */
  settles: boolean
}

/** Raised when a tender cannot be accepted; the service maps it to HTTP 4xx. */
export class TenderError extends Error {
  constructor(
    readonly code:
      | 'NON_POSITIVE_AMOUNT'
      | 'BILL_ALREADY_SETTLED'
      | 'NON_CASH_OVERPAYMENT',
    message: string
  ) {
    super(message)
    this.name = 'TenderError'
  }
}

/**
 * Validates a tender and derives its change + settlement outcome.
 *
 * Throws `TenderError` on an illegal tender:
 *   - a non-positive amount (a payment must move money; refunds go through a
 *     separate signed path, §7.4);
 *   - a tender against an already-settled bill (the remaining balance is zero);
 *   - a non-cash over-tender (no card change exists — the caller must send the
 *     exact remaining balance for a card/QRIS split, §7.2).
 */
export function computeTender(input: TenderInput): TenderResult {
  const { billTotal, priorTendered, amount, methodCountsAsCash } = input

  if (amount <= 0n) {
    throw new TenderError('NON_POSITIVE_AMOUNT', 'A payment amount must be positive.')
  }

  const remaining = billTotal - priorTendered
  if (remaining <= 0n) {
    throw new TenderError(
      'BILL_ALREADY_SETTLED',
      'The bill is already fully tendered; no further payment is needed.'
    )
  }

  const overpayment = amount - remaining
  if (overpayment > 0n && !methodCountsAsCash) {
    throw new TenderError(
      'NON_CASH_OVERPAYMENT',
      'A non-cash tender cannot exceed the remaining balance — there is no change to give. ' +
        'Send the exact remaining amount.'
    )
  }

  const changeGiven = overpayment > 0n ? overpayment : 0n
  const settles = priorTendered + amount >= billTotal

  return { changeGiven, settles }
}
