/**
 * Outbox worker — S1-06.
 *
 * In-process poller that dispatches undispatched events in batches. Consumers
 * are idempotent via `ProcessedEvent`, so a duplicate dispatch (restart, clock
 * skew) is safe.
 *
 * Standard #4: business write + OutboxEvent row in the same DB transaction.
 * Consumers never call producers directly — the POS emits `SaleCompleted` and
 * knows nothing about Accounting.
 */

import type { Logger } from '../logger.js'
import type { BrewsyncClient } from '@brewsync/db'
import { runWithTenantContext } from '@brewsync/db'
import type { Config } from '../config.js'
import type { SystemClient } from '../system-client.js'

export interface OutboxWorkerOptions {
  pollIntervalMs?: number
  batchSize?: number
  /**
   * Optional side-effect run for every event as it dispatches, before it is
   * marked processed. The realtime hubs (S7-05) subscribe here to fan events to
   * connected clients. Kept as a callback so the worker's core stays ignorant of
   * who consumes — producers never know their consumers (standard #4).
   */
  onEvent?: (event: DispatchedEvent) => void
}

/** The shape handed to `onEvent` — the persisted outbox row, minus bookkeeping. */
export interface DispatchedEvent {
  id: string
  /** Owning tenant — needed to bind RLS context for the dispatched-marker write. */
  tenantId: string
  type: string
  outletId: string | null
  payload: unknown
}

export class OutboxWorker {
  private running = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly db: BrewsyncClient,
    private readonly system: SystemClient,
    private readonly logger: Logger,
    private readonly options: OutboxWorkerOptions = {}
  ) {}

  start(): void {
    if (this.running) return

    this.running = true
    this.logger.info('Outbox worker starting')
    this.scheduleNext()
  }

  stop(): void {
    if (!this.running) return

    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.logger.info('Outbox worker stopped')
  }

  private scheduleNext(): void {
    if (!this.running) return

    const interval = this.options.pollIntervalMs ?? 2000
    this.timer = setTimeout(() => this.poll(), interval)
  }

  private async poll(): Promise<void> {
    try {
      await this.processBatch()
    } catch (error) {
      this.logger.error({ error }, 'Outbox worker poll failed')
    } finally {
      this.scheduleNext()
    }
  }

  private async processBatch(): Promise<void> {
    const batchSize = this.options.batchSize ?? 50

    // Cross-tenant sweep — the worker is deliberately unscoped. Reads run on the
    // system client (brewsync_system, BYPASSRLS): the app client is RLS-subject,
    // and with no bound GUC it would return zero rows. The dispatched-marker
    // writes below then bind each event's own tenant via runWithTenantContext,
    // so every mutation stays RLS-enforced — the system role has SELECT only.
    const events = await this.system.outboxEvent.findMany({
      where: { dispatchedAt: null },
      orderBy: { occurredAt: 'asc' },
      take: batchSize,
    })

    if (events.length === 0) return

    this.logger.debug({ count: events.length }, 'Processing outbox batch')

    for (const event of events) {
      await this.dispatch(event)
    }
  }

  private async dispatch(event: DispatchedEvent): Promise<void> {
    try {
      // Idempotency: check if already processed elsewhere (concurrent worker, retry).
      // `processedEvent` is global (no tenantId), so a plain scoped read suffices;
      // its unique key is the event id.
      const existing = await this.db.processedEvent.findUnique({
        where: { eventId_consumer: { eventId: event.id, consumer: 'default' } },
      })

      if (existing) {
        this.logger.debug({ eventId: event.id }, 'Event already processed')
        await this.markDispatched(event)
        return
      }

      // Fan to in-process consumers (realtime hubs, S7-05). Failure here must not
      // wedge the outbox — a dropped realtime frame is recoverable (clients
      // refetch), a stuck worker is not.
      if (this.options.onEvent) {
        try {
          this.options.onEvent(event)
        } catch (error) {
          this.logger.error({ eventId: event.id, error }, 'Outbox onEvent handler failed')
        }
      }

      this.logger.info({ eventId: event.id, type: event.type }, 'Event dispatched')

      // Bind the event's tenant: every row this worker writes is tenant-owned and
      // must pass RLS WITH CHECK under that tenant's GUC.
      await runWithTenantContext({ tenantId: event.tenantId }, () =>
        this.db.processedEvent.create({
          data: { eventId: event.id, consumer: 'default', processedAt: new Date() },
        })
      )

      await this.markDispatched(event)
    } catch (error) {
      this.logger.error({ eventId: event.id, error }, 'Event dispatch failed')

      await runWithTenantContext({ tenantId: event.tenantId }, () =>
        this.db.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts: { increment: 1 },
            lastError: error instanceof Error ? error.message : String(error),
          },
        })
      )
    }
  }

  private async markDispatched(event: DispatchedEvent): Promise<void> {
    await runWithTenantContext({ tenantId: event.tenantId }, () =>
      this.db.outboxEvent.update({
        where: { id: event.id },
        data: { dispatchedAt: new Date() },
      })
    )
  }
}

export function startOutboxWorker(
  db: BrewsyncClient,
  system: SystemClient,
  logger: Logger,
  config: Config,
  onEvent?: (event: DispatchedEvent) => void
): OutboxWorker {
  const worker = new OutboxWorker(db, system, logger, {
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
    ...(onEvent ? { onEvent } : {}),
  })

  worker.start()
  return worker
}
