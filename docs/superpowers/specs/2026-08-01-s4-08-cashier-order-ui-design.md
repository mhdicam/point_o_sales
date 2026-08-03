# S4-08 — Cashier Order UI (design)

Status: approved · 2026-08-01 · sprint task `S4-08` (design §6, §7, §19)

## Goal

Give the cashier a working tablet-first screen to build an order and watch the
bill total form in real time: product grid + order panel, add/edit/remove items,
apply discounts and gratuity, and drive the order through the state machine
(Send → Bill). This is the last open task in Sprint 4; the backend (S4-01…S4-07)
is already implemented and unit-tested.

Out of scope (later sprints): taking payment and closing shift (S5-08), tables
(S7), KDS (S7), channels (S8). The screen stops at `BILLED` — the same boundary
the backend `Order` model stops at.

## Fit with existing architecture

No new shell or routing concept. The screen mounts under the existing
`/admin` + `AdminLayout`, exactly like the master-data screens, and follows the
established patterns:

- **Routing:** one lazy route `/admin/order` added to `router.tsx`; one nav item
  "Order" added to `AdminLayout`'s `useNavItems`, shown when
  `usePermission(ORDER_CREATE)`.
- **State:** one Zustand store per domain over `apiRequest` (`orders.store.ts`),
  mirroring `products.store.ts` — holds the current order, `loading`/`error`,
  and mutation actions that re-read the order from the API response.
- **UI:** `ui/primitives.tsx` + `ui/Modal.tsx` + Tailwind tokens (`brand`,
  `ink`, `surface`, `line`, `min-h-tap`). No component library.
- **Motion:** CSS `transform`/`opacity` transitions honoring
  `prefers-reduced-motion` (design §19). Framer Motion stays reserved for
  `apps/landing` so the cashier bundle stays lean.
- **Money:** wire types are decimal strings (standard #2); the client never does
  money math — it renders the `OrderCharge` rows the pipeline returns (§6.2).

## Components

New folder `apps/pos/src/routes/order/`:

| File | Purpose |
|---|---|
| `OrderScreen.tsx` | Two-pane layout (grid + panel). Restructures to a bottom-sheet order panel on narrow screens (§19). Owns no money math. |
| `ProductGrid.tsx` | Tappable product cards for the active outlet. Reuses `useProductsStore`. Category filter + search. Large tap targets (≥44px). |
| `OrderPanel.tsx` | The running order: header (status badge, actions), line list, `ChargeBreakdown`, footer total. |
| `OrderLineRow.tsx` | One line: name, qty ±, line subtotal, remove/void, discount affordance. |
| `ChargeBreakdown.tsx` | Renders `charges` rows in `sortOrder` — discount/service-charge/tax/rounding/gratuity — then total. Never recomputes. |
| `ModifierDialog.tsx` | Shown when a chosen product has modifier groups; collects `modifierIds` before add. Uses `ui/Modal`. |
| `DiscountDialog.tsx` | Percent (bp) OR fixed-amount discount, item- or order-scoped. Uses `ui/Modal`. |

New store `apps/pos/src/stores/orders.store.ts` — actions map 1:1 to the order
routes: `create`, `addItem`, `changeItemQty`, `removeItem`, `applyItemDiscount`,
`applyOrderDiscount`, `setGratuity`, `send`, `markServed`, `bill`, `void`,
`voidItem`, `getById`, `clear`.

New pure helper `apps/pos/src/lib/order-view.ts` — derives display view-model
from an `Order`: grouped charge lines, formatted amounts (via existing
`money-input`), which actions are legal for the current status, whether the
panel is editable. This is the unit-tested seam.

Wire types added to `apps/pos/src/lib/types.ts`: `OrderStatus`, `OrderChannel`,
`OrderChargeKind`, `OrderCharge`, `OrderItem`, `Order` — money fields typed as
`string` to keep the no-float rule compiler-enforced.

## Data flow

1. Cashier taps a product. If it has modifier groups → `ModifierDialog` collects
   `modifierIds`. First item on an empty screen calls `POST /orders` with the
   active `outletId` (from the access store); subsequent taps call
   `POST /orders/:id/items`.
2. Every mutation returns the full order (items + charges); the store replaces
   `current`. `ChargeBreakdown` and the total re-render from those rows.
3. Discounts/gratuity: dialogs post to the discount/gratuity routes; same
   full-order response refreshes the panel.
4. **Send** (`ORDER_SEND`) freezes prices server-side (snapshot at SENT); the
   panel switches to non-editable (qty/remove hidden, item-void shown instead).
5. **Bill** flips to `BILLED`; charges freeze. Screen shows the final total and a
   "payment is next sprint" note. **Void** (`ORDER_VOID`) is available pre-PAID.

## Permission & feature gating (both sides — standard #5)

FE hides controls; the backend still guards every route (already implemented):

| Control | FE guard |
|---|---|
| Nav item + screen | `usePermission(ORDER_CREATE)` |
| Add/qty/remove | `usePermission(ORDER_EDIT)` |
| Send / Serve / Bill | `usePermission(ORDER_SEND)` |
| Discount / gratuity | `usePermission(DISCOUNT_APPLY)` |
| Void order | `usePermission(ORDER_VOID)` |
| Void item | `usePermission(ORDER_ITEM_VOID)` |
| Modifier picker | `useFeature('modifiers')` |
| Service-charge line | shown when present in charges (config-driven) |

Illegal transitions / frozen-order edits return HTTP 409 from the API; the store
surfaces `ApiError.message` in an `ErrorBanner` (reusing the primitive).

## Error handling

- Store catches `ApiError`, exposes `error: string | null`; screen renders
  `ErrorBanner`. Network/unknown → generic message (same pattern as
  `products.store.ts`).
- Optimistic UI is deliberately avoided: the pipeline is the source of truth, so
  the panel always reflects the server's charge rows, never a client guess.

## Testing

Pure FE logic only (no DB required locally):

- `apps/pos/src/lib/order-view.test.ts` — action legality per status, charge-row
  grouping/labelling, editable flag. Mirrors `product-form.test.ts`.
- Money formatting is already covered by `money-input.test.ts`.

Screen-level rendering is kept thin so the logic lives in the tested helper.
Backend pipeline/state-machine correctness is already unit-tested (35 tests
green). E2E (order → pay → close shift) is deferred to after S5 per the plan.

## Acceptance criteria (from sprint plan §10)

- [ ] Product grid + order panel, responsive tablet; add item fast, see running
  total.
- [ ] Order drives the state machine; illegal transitions rejected (409 surfaced).
- [ ] Every charge shows as an `OrderCharge` line (transparent breakdown, not just
  a total).
- [ ] Money rendered from integer-minor-unit strings; no float; rounding shown as
  its own line when present.
- [ ] Controls gated by permission/feature on the FE; backend already enforces.
- [ ] Checked at ≥2 breakpoints (phone portrait + tablet landscape).
