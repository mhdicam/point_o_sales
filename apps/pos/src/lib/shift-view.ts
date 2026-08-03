/**
 * Shift view-model — the tested seam between the wire `Shift` shape and the
 * cash-drawer screen (design §14, S5-08).
 *
 * Pure and money-math-free (standard #2/#3): the API already derived
 * `drawerBalance` (SUM of the ledger) and, at close, `expectedCash` and
 * `cashVariance`. This module only labels rows and answers status questions
 * (open? short/over?), so it can be unit-tested without React or a DB.
 */

import type { CashMovement, CashMovementType } from './types.ts'

const MOVEMENT_LABEL: Record<CashMovementType, string> = {
  OPENING_FLOAT: 'Opening float',
  CASH_SALE: 'Cash sale',
  CASH_REFUND: 'Cash refund',
  PAID_IN: 'Paid in',
  PAID_OUT: 'Paid out',
  DROP: 'Drop',
}

export function movementLabel(type: CashMovementType): string {
  return MOVEMENT_LABEL[type]
}

/** True when the amount decreases the drawer (leading minus on the wire string). */
export function isDebit(movement: CashMovement): boolean {
  return movement.amount.trim().startsWith('-')
}

export type VarianceState = 'balanced' | 'short' | 'over'

/**
 * Classify a closed shift's variance from its sign alone — no arithmetic. Returns
 * 'balanced' when there is no variance recorded (an open shift) or it is exactly
 * zero, 'short' for a negative variance (drawer under expected), 'over' for
 * positive.
 */
export function varianceState(cashVariance: string | null): VarianceState {
  if (cashVariance === null) return 'balanced'
  const v = cashVariance.trim()
  if (v === '' || v === '0' || v === '-0') return 'balanced'
  return v.startsWith('-') ? 'short' : 'over'
}
