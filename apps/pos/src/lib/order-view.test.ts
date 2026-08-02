import { describe, expect, it } from 'vitest'
import { buildOrderView, orderActionFlags } from './order-view.ts'
import type { Order, OrderCharge, OrderItem, OrderStatus } from './types.ts'

function item(over: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 'i1',
    variantId: 'v1',
    qty: 1,
    priceSnapshot: '0',
    nameSnapshot: '',
    modifierDeltaSnapshot: '0',
    modifiersSnapshot: null,
    unitPrice: '1000',
    lineSubtotal: '1000',
    ...over,
  }
}

function charge(over: Partial<OrderCharge> = {}): OrderCharge {
  return {
    id: 'c1',
    kind: 'TAX',
    label: 'Tax 11%',
    basis: '1000',
    rateBp: 1100,
    amount: '110',
    taxable: false,
    sortOrder: 0,
    orderItemId: null,
    ...over,
  }
}

function order(over: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    outletId: 'out1',
    status: 'OPEN',
    channel: 'STAFF',
    salesMethod: null,
    tableId: null,
    sentAt: null,
    billedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    items: [],
    charges: [],
    summary: { subtotal: '0', total: '0', amountDue: '0', taxContributesToTotal: true },
    ...over,
  }
}

describe('orderActionFlags', () => {
  it('allows item edits and send only while OPEN', () => {
    const open = orderActionFlags('OPEN')
    expect(open.editItems).toBe(true)
    expect(open.send).toBe(true)
    expect(open.serve).toBe(false)

    const sent = orderActionFlags('SENT')
    expect(sent.editItems).toBe(false)
    expect(sent.send).toBe(false)
    expect(sent.serve).toBe(true)
    expect(sent.bill).toBe(true)
  })

  it('permits discounts and item-void while pre-BILLED, not after', () => {
    for (const s of ['OPEN', 'SENT', 'SERVED'] as OrderStatus[]) {
      expect(orderActionFlags(s).discount).toBe(true)
      expect(orderActionFlags(s).voidItem).toBe(true)
    }
    for (const s of ['BILLED', 'PAID', 'CLOSED', 'VOID'] as OrderStatus[]) {
      expect(orderActionFlags(s).discount).toBe(false)
      expect(orderActionFlags(s).voidItem).toBe(false)
    }
  })

  it('permits whole-order void until money is taken (through BILLED)', () => {
    expect(orderActionFlags('BILLED').voidOrder).toBe(true)
    expect(orderActionFlags('PAID').voidOrder).toBe(false)
  })

  it('offers payment only once BILLED', () => {
    for (const s of ['OPEN', 'SENT', 'SERVED', 'PAID', 'CLOSED', 'VOID'] as OrderStatus[]) {
      expect(orderActionFlags(s).pay).toBe(false)
    }
    expect(orderActionFlags('BILLED').pay).toBe(true)
  })

  it('marks terminal/paid states frozen', () => {
    expect(orderActionFlags('OPEN').frozen).toBe(false)
    expect(orderActionFlags('BILLED').frozen).toBe(false)
    expect(orderActionFlags('PAID').frozen).toBe(true)
    expect(orderActionFlags('VOID').frozen).toBe(true)
  })
})

describe('buildOrderView', () => {
  it('formats the server summary without doing money math', () => {
    const v = buildOrderView(
      order({
        items: [item({ unitPrice: '1000', lineSubtotal: '2000', qty: 2 })],
        summary: { subtotal: '2000', total: '2220', amountDue: '2220', taxContributesToTotal: true },
      })
    )
    expect(v.subtotal).toBe('20.00')
    expect(v.total).toBe('22.20')
    expect(v.amountDue).toBe('22.20')
    expect(v.lines[0]?.unitPrice).toBe('10.00')
    expect(v.lines[0]?.lineSubtotal).toBe('20.00')
    expect(v.isEmpty).toBe(false)
  })

  it('uses the frozen nameSnapshot, falling back to the catalog name while OPEN', () => {
    const names = new Map([['v1', 'Latte']])
    const openView = buildOrderView(order({ items: [item({ nameSnapshot: '' })] }), {
      nameByVariant: names,
    })
    expect(openView.lines[0]?.name).toBe('Latte')

    const sentView = buildOrderView(order({ items: [item({ nameSnapshot: 'Latte (frozen)' })] }))
    expect(sentView.lines[0]?.name).toBe('Latte (frozen)')
  })

  it('attaches item discounts to their line and keeps order charges in the breakdown', () => {
    const v = buildOrderView(
      order({
        items: [item({ id: 'i1' })],
        charges: [
          charge({ id: 'd1', kind: 'DISCOUNT', label: 'Staff 10%', amount: '-100', orderItemId: 'i1', sortOrder: 0 }),
          charge({ id: 't1', kind: 'TAX', label: 'Tax 11%', amount: '99', orderItemId: null, sortOrder: 1 }),
        ],
      })
    )
    expect(v.lines[0]?.discounts).toHaveLength(1)
    expect(v.lines[0]?.discounts[0]).toMatchObject({ label: 'Staff 10%', amount: '-1.00', isCredit: true })
    expect(v.breakdown).toHaveLength(1)
    expect(v.breakdown[0]).toMatchObject({ kind: 'TAX', amount: '0.99', isCredit: false })
  })

  it('surfaces gratuity separately from the breakdown', () => {
    const v = buildOrderView(
      order({
        charges: [
          charge({ id: 'g1', kind: 'GRATUITY', label: 'Gratuity', amount: '500', rateBp: null, sortOrder: 5 }),
          charge({ id: 't1', kind: 'TAX', amount: '110', sortOrder: 1 }),
        ],
      })
    )
    expect(v.gratuity).toMatchObject({ kind: 'GRATUITY', amount: '5.00' })
    expect(v.breakdown.some((c) => c.kind === 'GRATUITY')).toBe(false)
  })

  it('renders frozen modifier snapshots on their line', () => {
    const v = buildOrderView(
      order({
        items: [
          item({
            modifiersSnapshot: [
              { modifierId: 'm1', name: 'Oat milk', priceDelta: '500' },
              { modifierId: 'm2', name: 'Extra shot', priceDelta: '300' },
            ],
          }),
        ],
      })
    )
    expect(v.lines[0]?.modifiers).toEqual([
      { name: 'Oat milk', priceDelta: '5.00' },
      { name: 'Extra shot', priceDelta: '3.00' },
    ])
  })

  it('flags an empty order', () => {
    expect(buildOrderView(order()).isEmpty).toBe(true)
  })

  it('carries the inclusive-tax memo flag through', () => {
    const v = buildOrderView(
      order({ summary: { subtotal: '1000', total: '1000', amountDue: '1000', taxContributesToTotal: false } })
    )
    expect(v.taxContributesToTotal).toBe(false)
  })
})
