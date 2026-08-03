/**
 * Shift cash reconciliation math — S5-06/07, design §14.
 *
 * Pure and DB-free, like `payment.settle.ts`: the drawer arithmetic (expected
 * cash from the movement ledger, the close variance, whether that variance
 * needs a reason) is the subtle money part of a shift, so it lives here and is
 * unit-tested with no fixtures.
 *
 * The model (design §14.3, standard #3 — the drawer is a derived balance, never
 * a stored column):
 *   - expectedCash = openingFloat + SUM(movement.amount). The OPENING_FLOAT
 *     movement written at open already carries the float, so callers pass the
 *     full movement sum; `expectedCash` is just that sum. (Kept as an explicit
 *     helper so the intent — and the standard it upholds — is legible.)
 *   - cashVariance = closingCountedCash − expectedCash. Negative = short,
 *     positive = over.
 *   - A variance whose magnitude exceeds the outlet tolerance requires a reason
 *     (§14.3); within tolerance it does not.
 *
 * Every amount is a `bigint` minor unit (standard #2).
 */

/** The signed drawer balance the ledger implies. */
export function expectedCash(movementSum: bigint): bigint {
  return movementSum
}

/** Counted − expected. Negative = drawer short, positive = drawer over. */
export function cashVariance(closingCountedCash: bigint, expected: bigint): bigint {
  return closingCountedCash - expected
}

/** Absolute value of a bigint — the variance magnitude compared to tolerance. */
export function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value
}

/**
 * Whether a variance is out of tolerance and so requires a reason at close
 * (§14.3). A zero tolerance means any non-zero variance needs a reason.
 */
export function varianceNeedsReason(variance: bigint, toleranceMinor: bigint): boolean {
  return absBigInt(variance) > toleranceMinor
}
