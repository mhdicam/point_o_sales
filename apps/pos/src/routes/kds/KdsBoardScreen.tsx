/**
 * KDS board screen — S7-07, design §5.5.
 *
 * The kitchen display: one column per prep station, each a FIFO stack of routed
 * tickets. Optimized for a wall-mounted screen read at distance — large type,
 * high-contrast status color, one primary tap per ticket (Start → Ready → Serve)
 * that walks the KDS state machine forward. It restructures to horizontally
 * scrolling columns on narrow screens (design §19) but is really meant for a
 * large landscape display.
 *
 * Realtime: the store loads the board over REST then subscribes to /ws/kds, so a
 * new ticket or a lane change from any till appears within ~2s without polling.
 * A `live` dot shows the socket state; when it drops the last board stays up.
 *
 * Gated on `features.kds` + KDS_BUMP (nav hides otherwise; backend re-checks).
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS } from '@brewsync/shared'
import { useAuthStore } from '../../stores/auth.store.ts'
import { useKdsStore } from '../../stores/kds.store.ts'
import { apiRequest, ApiError } from '../../lib/api-client.ts'
import { usePermission } from '../../hooks/usePermission.ts'
import { useFeature } from '../../hooks/useFeature.ts'
import {
  buildLanes,
  bumpLabel,
  nextBump,
  ticketTone,
  type KdsTone,
} from '../../lib/kds-view.ts'
import type { KdsStatus, KdsTicket } from '../../lib/types.ts'
import { ErrorBanner, Spinner } from '../../ui/primitives.tsx'

const TONE_CLASS: Record<KdsTone, string> = {
  queued: 'border-line bg-surface',
  preparing: 'border-brand/50 bg-brand/5',
  ready: 'border-brand bg-brand/10',
}

export function KdsBoardScreen(): ReactNode {
  const outletId = useAuthStore((s) => s.scope?.outletId ?? null)
  const canBump = usePermission(PERMISSIONS.KDS_BUMP)
  const kdsOn = useFeature('kds')

  const board = useKdsStore((s) => s.board)
  const loading = useKdsStore((s) => s.loading)
  const error = useKdsStore((s) => s.error)
  const live = useKdsStore((s) => s.live)
  const connect = useKdsStore((s) => s.connect)
  const disconnect = useKdsStore((s) => s.disconnect)
  const refresh = useKdsStore((s) => s.refresh)

  useEffect(() => {
    if (outletId && kdsOn) void connect(outletId)
    return () => disconnect()
  }, [outletId, kdsOn, connect, disconnect])

  const lanes = useMemo(() => (board ? buildLanes(board) : []), [board])

  if (!outletId) {
    return (
      <div className="p-2">
        <ErrorBanner message="The kitchen board needs an outlet-scoped session. Re-select your scope with an outlet." />
      </div>
    )
  }
  if (!kdsOn) {
    return (
      <div className="p-2">
        <ErrorBanner message="The KDS feature is off for this outlet." />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-ink">Kitchen</h1>
          <span
            className={`inline-flex items-center gap-1.5 text-xs ${live ? 'text-brand' : 'text-ink-muted'}`}
            title={live ? 'Live' : 'Reconnecting…'}
          >
            <span
              className={`h-2 w-2 rounded-full ${live ? 'bg-brand' : 'bg-ink-muted'}`}
              aria-hidden
            />
            {live ? 'Live' : 'Offline'}
          </span>
        </div>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {loading && !board ? (
        <Spinner label="Loading board…" />
      ) : lanes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-muted">
          No stations configured. Add prep stations in Floor plan → Stations.
        </div>
      ) : (
        <div className="flex flex-1 gap-4 overflow-x-auto pb-2">
          {lanes.map((lane) => (
            <Lane
              key={lane.stationId}
              name={lane.name}
              tickets={lane.tickets}
              canBump={canBump}
              onBumped={refresh}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Lane({
  name,
  tickets,
  canBump,
  onBumped,
}: {
  name: string
  tickets: KdsTicket[]
  canBump: boolean
  onBumped: () => void
}): ReactNode {
  return (
    <section className="flex w-72 shrink-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">{name}</h2>
        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink-muted">
          {tickets.length}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {tickets.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-ink-muted">
            Clear
          </p>
        ) : (
          tickets.map((t) => (
            <TicketCard key={t.id} ticket={t} canBump={canBump} onBumped={onBumped} />
          ))
        )}
      </div>
    </section>
  )
}

function TicketCard({
  ticket,
  canBump,
  onBumped,
}: {
  ticket: KdsTicket
  canBump: boolean
  onBumped: () => void
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const status = ticket.kdsStatus
  const forward = nextBump(status)
  const tone = ticketTone(status)
  const mods = ticket.modifiersSnapshot ?? []

  const bump = async (to: KdsStatus): Promise<void> => {
    setErr(null)
    setBusy(true)
    try {
      await apiRequest(`/kds/items/${ticket.id}/status`, { method: 'POST', body: { status: to } })
      // The realtime frame will also arrive, but refetch now so this screen
      // updates instantly rather than waiting a round trip through the outbox.
      onBumped()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Unable to update')
      setBusy(false)
    }
  }

  return (
    <article className={`flex flex-col gap-2 rounded-xl border-2 p-3 ${TONE_CLASS[tone]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold text-ink">
          {ticket.qty}× {ticket.nameSnapshot}
        </span>
      </div>
      {mods.length > 0 ? (
        <ul className="text-sm text-ink-muted">
          {mods.map((m) => (
            <li key={m.modifierId}>+ {m.name}</li>
          ))}
        </ul>
      ) : null}
      {ticket.order.tableId ? (
        <span className="text-xs text-ink-muted">Table order</span>
      ) : null}

      {err ? <p className="text-xs text-danger">{err}</p> : null}

      {canBump && forward ? (
        <div className="mt-1 flex gap-2">
          <button
            onClick={() => bump(forward)}
            disabled={busy}
            className="min-h-tap flex-1 rounded-lg bg-brand px-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '…' : bumpLabel(status)}
          </button>
          <button
            onClick={() => bump('VOID')}
            disabled={busy}
            title="Void this ticket"
            className="min-h-tap min-w-tap rounded-lg border border-line text-ink-muted transition hover:text-danger disabled:opacity-50"
          >
            ✕
          </button>
        </div>
      ) : null}
    </article>
  )
}
