/**
 * Transactional outbox — S1-06, standard #4 (design §8).
 *
 * `emitEvent` writes the event row using the SAME transaction client as the
 * business change. That is the whole point: either both land or neither does,
 * so an event can never describe a write that was rolled back, and a write can
 * never quietly lose its event.
 *
 * The function therefore takes a `tx` rather than reaching for a module-level
 * client — passing the transaction is what makes the guarantee, so the API
 * makes it impossible to forget.
 */

import type { EventType } from '@brewsync/shared'

/** Minimal shape needed from a Prisma transaction client. */
export interface OutboxCapableTx {
  outboxEvent: {
    create(args: {
      data: {
        tenantId: string
        outletId?: string | null
        type: string
        payload: unknown
      }
    }): Promise<{ id: string }>
  }
}

export interface EmitEventInput {
  tenantId: string
  outletId?: string | null | undefined
  type: EventType
  /**
   * Self-contained snapshot (design §8.2), not just an id. A consumer must be
   * able to act without querying back into POS — that is what makes the
   * decoupling real.
   */
  payload: unknown
}

export async function emitEvent(tx: OutboxCapableTx, input: EmitEventInput): Promise<string> {
  const event = await tx.outboxEvent.create({
    data: {
      tenantId: input.tenantId,
      outletId: input.outletId ?? null,
      type: input.type,
      payload: serializePayload(input.payload),
    },
  })
  return event.id
}

/**
 * BigInt is not valid JSON, and money is BigInt everywhere (standard #2).
 * Serialize to string so amounts survive the round-trip without a float in the
 * middle. Consumers parse back with BigInt().
 */
export function serializePayload(payload: unknown): unknown {
  return JSON.parse(
    JSON.stringify(payload, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  ) as unknown
}
