import { describe, expect, it } from 'vitest'
import {
  billLabel,
  canRefund,
  canSplit,
  defaultMethodId,
  isFullySettled,
  openBills,
} from './payment-view.ts'
import type { Bill, Payment, PaymentMethod } from './types.ts'

function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: 'p1',
    billId: 'b1',
    methodId: 'm1',
    amount: '1000',
    changeGiven: '0',
    refNo: null,
    reason: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

function bill(over: Partial<Bill> = {}): Bill {
  return {
    id: 'b1',
    orderId: 'o1',
    seq: 1,
    status: 'OPEN',
    subtotal: '1000',
    total: '1110',
    label: null,
    paidAt: null,
    payments: [],
    tendered: '0',
    remaining: '1110',
    ...over,
  }
}

function method(over: Partial<PaymentMethod> = {}): PaymentMethod {
  return {
    id: 'm1',
    code: 'CARD',
    name: 'Card',
    kind: 'CARD',
    opensCashDrawer: false,
    needsRefNo: true,
    countsAsCash: false,
    isActive: true,
    sortOrder: 1,
    ...over,
  }
}

describe('openBills / isFullySettled', () => {
  it('filters to OPEN bills', () => {
    const bills = [bill({ id: 'b1', status: 'OPEN' }), bill({ id: 'b2', status: 'PAID' })]
    expect(openBills(bills).map((b) => b.id)).toEqual(['b1'])
  })

  it('is settled only when every bill is PAID', () => {
    expect(isFullySettled([])).toBe(false)
    expect(isFullySettled([bill({ status: 'PAID' })])).toBe(true)
    expect(isFullySettled([bill({ status: 'PAID' }), bill({ id: 'b2', status: 'OPEN' })])).toBe(false)
  })
})

describe('canSplit', () => {
  it('allows only a single unpaid OPEN bill on a BILLED order', () => {
    expect(canSplit('BILLED', [bill()])).toBe(true)
  })

  it('rejects when not BILLED, already split, or already tendered', () => {
    expect(canSplit('SENT', [bill()])).toBe(false)
    expect(canSplit('BILLED', [bill({ id: 'b1' }), bill({ id: 'b2', seq: 2 })])).toBe(false)
    expect(canSplit('BILLED', [bill({ payments: [payment()] })])).toBe(false)
    expect(canSplit('BILLED', [bill({ status: 'PAID' })])).toBe(false)
    expect(canSplit('BILLED', [])).toBe(false)
  })
})

describe('canRefund', () => {
  it('offers a refund on a paid bill with a positive tender', () => {
    expect(canRefund(bill({ status: 'PAID', payments: [payment({ amount: '1110' })] }))).toBe(true)
  })

  it('does not offer a refund on an open bill or one with only negatives', () => {
    expect(canRefund(bill({ status: 'OPEN', payments: [payment({ amount: '1110' })] }))).toBe(false)
    expect(canRefund(bill({ status: 'PAID', payments: [payment({ amount: '-1110' })] }))).toBe(false)
  })
})

describe('billLabel', () => {
  it('prefers the explicit label, else "Bill N"', () => {
    expect(billLabel(bill({ label: 'Andi' }))).toBe('Andi')
    expect(billLabel(bill({ label: null, seq: 3 }))).toBe('Bill 3')
  })
})

describe('defaultMethodId', () => {
  it('prefers an active cash method, else the first active', () => {
    const cash = method({ id: 'cash', kind: 'CASH', countsAsCash: true, needsRefNo: false })
    const card = method({ id: 'card' })
    expect(defaultMethodId([card, cash])).toBe('cash')
    expect(defaultMethodId([card])).toBe('card')
    expect(defaultMethodId([])).toBe(null)
    expect(defaultMethodId([method({ id: 'x', isActive: false })])).toBe(null)
  })
})
