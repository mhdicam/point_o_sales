/**
 * Payment view-model — the tested seam between the wire `Bill`/`Order` shapes and
 * the settlement screen (design §7, S5-08).
 *
 * Pure and money-math-free by design (standard #2): the API already computed
 * every amount — each bill's `tendered`/`remaining`, and `changeGiven` on a
 * settling payment. This module answers only *status* questions (which bills can
 * still take a tender, whether the order is settled, whether a split is legal),
 * so it can be unit-tested without React or a DB. Nothing here adds, subtracts,
 * or rounds money — that stays in the backend pipeline.
 */

import type { Bill, OrderStatus, PaymentMethod } from './types.ts'

/** Bills that can still take a tender (design §7.1). */
export function openBills(bills: Bill[]): Bill[] {
  return bills.filter((b) => b.status === 'OPEN')
}

/**
 * True once every bill on the order is settled — the order is PAID. Derived from
 * bill *statuses*, never by summing money.
 */
export function isFullySettled(bills: Bill[]): boolean {
  return bills.length > 0 && bills.every((b) => b.status === 'PAID')
}

/**
 * A split is only legal before any tender lands: the order is BILLED, there is
 * exactly one bill, it is still OPEN, and it has no payments (§7.3). Mirrors the
 * backend guard in `PaymentService.split`; the backend re-checks regardless.
 */
export function canSplit(orderStatus: OrderStatus, bills: Bill[]): boolean {
  if (orderStatus !== 'BILLED') return false
  if (bills.length !== 1) return false
  const only = bills[0]
  return only !== undefined && only.status === 'OPEN' && only.payments.length === 0
}

/**
 * A refund is offered on a settled bill that still has money on it. "Has money"
 * is a status/sign proxy for UI gating — at least one positive tender that is not
 * already fully reversed — the backend enforces the exact `netCollected` ceiling.
 */
export function canRefund(bill: Bill): boolean {
  if (bill.status !== 'PAID') return false
  return bill.payments.some((p) => !p.amount.trim().startsWith('-'))
}

/** A display label for a bill: its explicit split label, else "Bill N". */
export function billLabel(bill: Bill): string {
  return bill.label ?? `Bill ${bill.seq}`
}

/** The default tender for a method picker: first cash method, else the first. */
export function defaultMethodId(methods: PaymentMethod[]): string | null {
  const cash = methods.find((m) => m.countsAsCash && m.isActive)
  return (cash ?? methods.find((m) => m.isActive))?.id ?? null
}
