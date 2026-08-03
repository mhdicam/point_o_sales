/**
 * OrderScreen — the cashier order workspace (design §6/§7, §19; S4-08).
 *
 * Two-pane on a tablet: the tap-to-add product grid and the running order panel.
 * On a narrow phone it stacks (grid above, order below) per §19 (layout
 * restructures, not just shrinks). It owns the orchestration only:
 *
 *   - reads the catalog (products.store) and the working order (orders.store);
 *   - derives the render model once via `buildOrderView` (all money already
 *     computed server-side — this screen does none, standard #2);
 *   - resolves the add flow (default variant, and modifier groups when the
 *     `modifiers` feature is on) before delegating the API call to the store;
 *   - passes down permission×status gates (standard #5) — the backend re-checks.
 *
 * The order is created lazily on the first add, scoped to the session outlet.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { PERMISSIONS } from '@brewsync/shared'
import { apiRequest } from '../../lib/api-client.ts'
import { buildOrderView } from '../../lib/order-view.ts'
import { inputToMinor } from '../../lib/money-input.ts'
import { useAuthStore } from '../../stores/auth.store.ts'
import { useProductsStore } from '../../stores/products.store.ts'
import { useOrdersStore } from '../../stores/orders.store.ts'
import { useSalesMethodsStore } from '../../stores/sales-methods.store.ts'
import type { DiscountPayload } from '../../stores/orders.store.ts'
import { usePermission } from '../../hooks/usePermission.ts'
import { useFeature } from '../../hooks/useFeature.ts'
import type { ModifierGroup, ProductListItem } from '../../lib/types.ts'
import { Button, ErrorBanner, Field, Input, Select, Spinner } from '../../ui/primitives.tsx'
import { Modal } from '../../ui/Modal.tsx'
import { ProductGrid } from './ProductGrid.tsx'
import { OrderPanel } from './OrderPanel.tsx'
import type { OrderPanelPermissions } from './OrderPanel.tsx'
import { ModifierDialog } from './ModifierDialog.tsx'
import { DiscountDialog } from './DiscountDialog.tsx'

/** The default sellable variant for a tapped product. */
function defaultVariantId(product: ProductListItem): string | null {
  const variant = product.variants.find((v) => v.isActive && v.isDefault) ?? product.variants.find((v) => v.isActive)
  return variant?.id ?? null
}

/** Small fixed-amount dialog for gratuity (outside the total, §6 step 7). */
function GratuityDialog({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean
  onClose: () => void
  onSubmit: (gratuityMinor: string) => void
}): ReactNode {
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const minor = inputToMinor(amount, 2)
    if (minor === null || minor.startsWith('-')) {
      setError('Enter a valid amount (0 to clear).')
      return
    }
    onSubmit(minor)
  }

  return (
    <Modal
      title="Gratuity"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            Apply
          </Button>
        </>
      }
    >
      <Field label="Amount">
        <Input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="5.00"
          autoFocus
        />
      </Field>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
    </Modal>
  )
}

/** Which discount dialog is open, and what it targets. */
type DiscountTarget = { kind: 'order' } | { kind: 'item'; itemId: string }

/** A product whose modifier groups are being chosen before add. */
interface PendingModifier {
  product: ProductListItem
  variantId: string
  groups: ModifierGroup[]
}

export function OrderScreen(): ReactNode {
  const outletId = useAuthStore((s) => s.scope?.outletId ?? null)
  const navigate = useNavigate()

  const products = useProductsStore((s) => s.items)
  const productsLoading = useProductsStore((s) => s.loading)
  const listProducts = useProductsStore((s) => s.list)

  const salesMethods = useSalesMethodsStore((s) => s.items)
  const listSalesMethods = useSalesMethodsStore((s) => s.list)

  const order = useOrdersStore((s) => s.current)
  const busy = useOrdersStore((s) => s.busy)
  const error = useOrdersStore((s) => s.error)
  const {
    create,
    addItem,
    changeItemQty,
    removeItem,
    applyItemDiscount,
    applyOrderDiscount,
    setGratuity,
    send,
    markServed,
    bill,
    voidOrder,
    voidItem,
    clear,
  } = useOrdersStore.getState()

  const canEdit = usePermission(PERMISSIONS.ORDER_EDIT)
  const canSend = usePermission(PERMISSIONS.ORDER_SEND)
  const canVoidItem = usePermission(PERMISSIONS.ORDER_ITEM_VOID)
  const canVoidOrder = usePermission(PERMISSIONS.ORDER_VOID)
  const canDiscount = usePermission(PERMISSIONS.DISCOUNT_APPLY)
  const canPay = usePermission(PERMISSIONS.PAYMENT_ACCEPT)
  const modifiersOn = useFeature('modifiers')

  const [pending, setPending] = useState<PendingModifier | null>(null)
  const [discountTarget, setDiscountTarget] = useState<DiscountTarget | null>(null)
  const [gratuityOpen, setGratuityOpen] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  // The chosen method for a not-yet-created order. Once the order exists its
  // method is fixed (order.salesMethod), so the picker reflects that instead.
  const [salesMethod, setSalesMethod] = useState('')

  useEffect(() => {
    void listProducts()
    void listSalesMethods()
  }, [listProducts, listSalesMethods])

  // Start each visit with a clean slate; a billed/closed order stays out of the way.
  useEffect(() => {
    return () => clear()
  }, [clear])

  const nameByVariant = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of products) {
      for (const v of p.variants) map.set(v.id, v.name.trim() !== '' ? v.name : p.name)
    }
    return map
  }, [products])

  const view = useMemo(
    () => (order ? buildOrderView(order, { nameByVariant }) : null),
    [order, nameByVariant]
  )

  /** Ensure an order exists, then run a mutation that assumes `current` is set. */
  const withOrder = async (run: () => Promise<void>): Promise<void> => {
    if (!useOrdersStore.getState().current) {
      if (!outletId) {
        setPickError('Select an outlet for this session first.')
        return
      }
      await create({ outletId, ...(salesMethod !== '' ? { salesMethod } : {}) })
      if (!useOrdersStore.getState().current) return // create failed; error already set
    }
    await run()
  }

  const addResolved = async (variantId: string, modifierIds?: string[]): Promise<void> => {
    await withOrder(() =>
      addItem({ variantId, qty: 1, ...(modifierIds && modifierIds.length > 0 ? { modifierIds } : {}) })
    )
  }

  const onPick = async (product: ProductListItem): Promise<void> => {
    setPickError(null)
    const variantId = defaultVariantId(product)
    if (!variantId) {
      setPickError(`${product.name} has no sellable variant.`)
      return
    }
    if (modifiersOn) {
      try {
        const res = await apiRequest<{ groups: ModifierGroup[] }>(
          `/products/${product.id}/modifier-groups`
        )
        const active = res.groups.filter((g) => g.isActive)
        if (active.length > 0) {
          setPending({ product, variantId, groups: active })
          return
        }
      } catch {
        // A modifier lookup failure shouldn't block a plain add; fall through.
      }
    }
    await addResolved(variantId)
  }

  const perms: OrderPanelPermissions = {
    edit: canEdit,
    send: canSend,
    voidItem: canVoidItem,
    voidOrder: canVoidOrder,
    discount: canDiscount,
    pay: canPay,
  }

  const onDiscountSubmit = async (discount: DiscountPayload): Promise<void> => {
    const target = discountTarget
    setDiscountTarget(null)
    if (!target) return
    if (target.kind === 'order') await applyOrderDiscount(discount)
    else await applyItemDiscount(target.itemId, discount)
  }

  if (!outletId) {
    return (
      <div className="p-6">
        <ErrorBanner message="This screen needs an outlet-scoped session. Re-select your scope with an outlet." />
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh_-_6rem)] flex-col gap-4 sm:h-[calc(100vh_-_4rem)] lg:flex-row">
      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-ink">New order</h1>
          {salesMethods.length > 0 ? (
            order ? (
              // The method is fixed once the order exists; show it, don't offer a change.
              <span className="text-sm text-ink-muted">
                {salesMethods.find((m) => m.code === order.salesMethod)?.name ??
                  order.salesMethod ??
                  'No method'}
              </span>
            ) : (
              <label className="flex items-center gap-2 text-sm text-ink-muted">
                Method
                <Select
                  value={salesMethod}
                  onChange={(e) => setSalesMethod(e.target.value)}
                  disabled={busy}
                >
                  <option value="">Default</option>
                  {salesMethods.map((m) => (
                    <option key={m.id} value={m.code}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </label>
            )
          ) : null}
        </header>
        {pickError ? <ErrorBanner message={pickError} /> : null}
        {productsLoading && products.length === 0 ? (
          <Spinner />
        ) : (
          <div className="min-h-0 flex-1">
            <ProductGrid products={products} busy={busy} onPick={(p) => void onPick(p)} />
          </div>
        )}
      </section>

      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface lg:w-96">
        {error ? (
          <div className="px-4 pt-3">
            <ErrorBanner message={error} />
          </div>
        ) : null}
        {view ? (
          <OrderPanel
            view={view}
            perms={perms}
            busy={busy}
            onChangeQty={(itemId, qty) => {
              if (qty < 1) void removeItem(itemId)
              else void changeItemQty(itemId, qty)
            }}
            onRemove={(itemId) => void removeItem(itemId)}
            onVoidItem={(itemId) => void voidItem(itemId)}
            onItemDiscount={(itemId) => setDiscountTarget({ kind: 'item', itemId })}
            onOrderDiscount={() => setDiscountTarget({ kind: 'order' })}
            onGratuity={() => setGratuityOpen(true)}
            onSend={() => void send()}
            onServe={() => void markServed()}
            onBill={() => void bill()}
            onPay={() => {
              const id = useOrdersStore.getState().current?.id
              if (id) navigate(`/admin/pay/${id}`)
            }}
            onVoidOrder={() => void voidOrder()}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-ink-muted">
            Tap a product to start an order.
          </div>
        )}
      </section>

      {pending ? (
        <ModifierDialog
          productName={pending.product.name}
          groups={pending.groups}
          busy={busy}
          onClose={() => setPending(null)}
          onConfirm={(modifierIds) => {
            const { variantId } = pending
            setPending(null)
            void addResolved(variantId, modifierIds)
          }}
        />
      ) : null}

      {discountTarget ? (
        <DiscountDialog
          title={discountTarget.kind === 'order' ? 'Order discount' : 'Item discount'}
          busy={busy}
          onClose={() => setDiscountTarget(null)}
          onSubmit={(discount) => void onDiscountSubmit(discount)}
        />
      ) : null}

      {gratuityOpen ? (
        <GratuityDialog
          busy={busy}
          onClose={() => setGratuityOpen(false)}
          onSubmit={(minor) => {
            setGratuityOpen(false)
            void setGratuity(minor)
          }}
        />
      ) : null}
    </div>
  )
}
