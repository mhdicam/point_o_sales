/**
 * ShiftScreen — the cash-drawer session (design §14, S5-06/07; S5-08).
 *
 * One register's shift lifecycle, mounted under `/admin/shift`:
 *
 *   - no open shift → an open-float form (SHIFT_OPEN);
 *   - open shift → the derived drawer balance, the append-only movement ledger,
 *     a manual paid-in/out/drop form (SHIFT_CASH_MOVEMENT), and a close-with-count
 *     form (SHIFT_CLOSE);
 *   - just-closed shift → the reconciliation (expected vs counted vs variance),
 *     then a shortcut to open the next shift.
 *
 * It does no money math and never sums the ledger (standards #2/#3): the drawer
 * balance, expected cash, and variance are all server-derived — this screen only
 * formats and labels them. Every action ANDs a permission (standard #5) with the
 * shift state; the backend re-checks both.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS } from '@brewsync/shared'
import { inputToMinor, minorToInput } from '../../lib/money-input.ts'
import { isDebit, movementLabel, varianceState } from '../../lib/shift-view.ts'
import type { Shift } from '../../lib/types.ts'
import { useAuthStore } from '../../stores/auth.store.ts'
import { useShiftStore } from '../../stores/shift.store.ts'
import type { MovementPayload } from '../../stores/shift.store.ts'
import { usePermission } from '../../hooks/usePermission.ts'
import { Badge, Button, EmptyState, ErrorBanner, Field, Input, Select, Spinner } from '../../ui/primitives.tsx'

const VARIANCE_TONE = {
  balanced: { label: 'Balanced', className: 'text-ink' },
  short: { label: 'Short', className: 'text-danger' },
  over: { label: 'Over', className: 'text-brand' },
} as const

/** Open a shift with a starting cash float. */
function OpenShiftForm({
  busy,
  onOpen,
}: {
  busy: boolean
  onOpen: (openingFloatMinor: string) => void
}): ReactNode {
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const minor = inputToMinor(amount, 2)
    if (minor === null || minor.startsWith('-')) {
      setError('Enter a valid opening float (0 for an empty drawer).')
      return
    }
    setError(null)
    onOpen(minor)
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-3 rounded-xl border border-line bg-surface p-6">
      <div>
        <h2 className="text-base font-semibold text-ink">Open a shift</h2>
        <p className="text-sm text-ink-muted">Count the drawer and enter the starting cash.</p>
      </div>
      <Field label="Opening float">
        <Input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          autoFocus
        />
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button disabled={busy} onClick={submit}>
        Open shift
      </Button>
    </div>
  )
}

/** Record a manual cash movement (paid in / paid out / drop). */
function MovementForm({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (input: MovementPayload) => void
}): ReactNode {
  const [type, setType] = useState<MovementPayload['type']>('PAID_IN')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const minor = inputToMinor(amount, 2)
    if (minor === null || minor.startsWith('-') || minor === '0') {
      setError('Enter a valid amount.')
      return
    }
    if (reason.trim() === '') {
      setError('A movement needs a reason.')
      return
    }
    setError(null)
    onSubmit({ type, amountMinor: minor, reason: reason.trim() })
    setAmount('')
    setReason('')
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold text-ink">Cash movement</h3>
      <div className="flex gap-2">
        <div className="flex-1">
          <Field label="Type">
            <Select
              value={type}
              onChange={(e) => setType(e.target.value as MovementPayload['type'])}
              disabled={busy}
            >
              <option value="PAID_IN">Paid in</option>
              <option value="PAID_OUT">Paid out</option>
              <option value="DROP">Drop</option>
            </Select>
          </Field>
        </div>
        <div className="flex-1">
          <Field label="Amount">
            <Input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              disabled={busy}
            />
          </Field>
        </div>
      </div>
      <Field label="Reason">
        <Input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Petty cash, bank drop, …"
          disabled={busy}
        />
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button variant="secondary" disabled={busy} onClick={submit}>
        Record movement
      </Button>
    </div>
  )
}

/** Close the shift by counting the drawer; the server computes expected + variance. */
function CloseShiftForm({
  busy,
  onClose,
}: {
  busy: boolean
  onClose: (closingCountedCashMinor: string, reason?: string) => void
}): ReactNode {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const minor = inputToMinor(amount, 2)
    if (minor === null || minor.startsWith('-')) {
      setError('Enter the counted cash (0 for an empty drawer).')
      return
    }
    setError(null)
    onClose(minor, reason.trim() === '' ? undefined : reason.trim())
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold text-ink">Close shift</h3>
      <p className="text-sm text-ink-muted">Count the drawer; the expected total and variance are computed on close.</p>
      <Field label="Counted cash">
        <Input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          disabled={busy}
        />
      </Field>
      <Field label="Note (optional)">
        <Input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Explain any variance"
          disabled={busy}
        />
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button variant="danger" disabled={busy} onClick={submit}>
        Close shift
      </Button>
    </div>
  )
}

/** The reconciliation of a just-closed shift. */
function CloseSummary({ shift, onNew }: { shift: Shift; onNew: () => void }): ReactNode {
  const state = varianceState(shift.cashVariance)
  const tone = VARIANCE_TONE[state]
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-3 rounded-xl border border-line bg-surface p-6">
      <h2 className="text-base font-semibold text-ink">Shift closed</h2>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-ink-muted">Expected in drawer</dt>
          <dd className="font-medium text-ink">{minorToInput(shift.expectedCash ?? '0')}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-muted">Counted</dt>
          <dd className="font-medium text-ink">{minorToInput(shift.closingCountedCash ?? '0')}</dd>
        </div>
        <div className="flex justify-between border-t border-line pt-2">
          <dt className="text-ink-muted">Variance</dt>
          <dd className={`font-semibold ${tone.className}`}>
            {minorToInput(shift.cashVariance ?? '0')} · {tone.label}
          </dd>
        </div>
      </dl>
      <Button onClick={onNew}>Open a new shift</Button>
    </div>
  )
}

/** An open shift: derived balance, ledger, and the movement/close actions. */
function OpenShiftPanel({
  shift,
  busy,
  canMovement,
  canClose,
  onMovement,
  onClose,
}: {
  shift: Shift
  busy: boolean
  canMovement: boolean
  canClose: boolean
  onMovement: (input: MovementPayload) => void
  onClose: (closingCountedCashMinor: string, reason?: string) => void
}): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-brand/30 bg-brand/5 p-6 text-center">
        <p className="text-xs uppercase tracking-wide text-ink-muted">Drawer balance</p>
        <p className="text-3xl font-bold text-ink">{minorToInput(shift.drawerBalance)}</p>
        <p className="mt-1 text-xs text-ink-muted">
          Opened with {minorToInput(shift.openingFloat)} · <Badge tone="active">Open</Badge>
        </p>
      </div>

      <div className="rounded-xl border border-line bg-surface">
        <h3 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">Movements</h3>
        {shift.movements.length === 0 ? (
          <EmptyState title="No movements yet" hint="Cash sales, refunds, and manual entries appear here." />
        ) : (
          <ul className="divide-y divide-line">
            {shift.movements.map((m) => {
              const debit = isDebit(m)
              return (
                <li key={m.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-ink-muted">
                    {movementLabel(m.type)}
                    {m.reason ? ` · ${m.reason}` : ''}
                  </span>
                  <span className={debit ? 'text-danger' : 'text-ink'}>{minorToInput(m.amount)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {canMovement ? <MovementForm busy={busy} onSubmit={onMovement} /> : null}
      {canClose ? <CloseShiftForm busy={busy} onClose={onClose} /> : null}
    </div>
  )
}

export function ShiftScreen(): ReactNode {
  const outletId = useAuthStore((s) => s.scope?.outletId ?? null)

  const current = useShiftStore((s) => s.current)
  const loaded = useShiftStore((s) => s.loaded)
  const busy = useShiftStore((s) => s.busy)
  const error = useShiftStore((s) => s.error)
  const { load, open, addMovement, close, clear } = useShiftStore.getState()

  const canOpen = usePermission(PERMISSIONS.SHIFT_OPEN)
  const canClose = usePermission(PERMISSIONS.SHIFT_CLOSE)
  const canMovement = usePermission(PERMISSIONS.SHIFT_CASH_MOVEMENT)

  useEffect(() => {
    if (outletId) void load(outletId)
    return () => clear()
  }, [outletId, load, clear])

  if (!outletId) {
    return (
      <div className="p-6">
        <ErrorBanner message="This screen needs an outlet-scoped session. Re-select your scope with an outlet." />
      </div>
    )
  }

  const onOpen = (openingFloatMinor: string): void => {
    void open({ outletId, openingFloatMinor })
  }
  const onMovement = (input: MovementPayload): void => {
    if (current) void addMovement(current.id, input)
  }
  const onClose = (closingCountedCashMinor: string, reason?: string): void => {
    if (current) void close(current.id, { closingCountedCashMinor, ...(reason ? { reason } : {}) })
  }

  const closed = current !== null && current.status !== 'OPEN'

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold text-ink">Cash drawer</h1>
        <p className="text-xs text-ink-muted">Open, reconcile, and close the register shift.</p>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {!loaded ? (
        <Spinner label="Loading shift…" />
      ) : closed && current ? (
        <CloseSummary shift={current} onNew={() => clear()} />
      ) : current ? (
        <OpenShiftPanel
          shift={current}
          busy={busy}
          canMovement={canMovement}
          canClose={canClose}
          onMovement={onMovement}
          onClose={onClose}
        />
      ) : canOpen ? (
        <OpenShiftForm busy={busy} onOpen={onOpen} />
      ) : (
        <EmptyState title="No open shift" hint="You do not have permission to open a shift." />
      )}
    </div>
  )
}
