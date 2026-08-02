/**
 * KDS lane state machine — S7-04, standard #6 / design §5.1.
 *
 * The single source of transition truth for a kitchen line's prep lane. Declared
 * as data through `defineStateMachine`, so the KDS service never hand-rolls a
 * `switch` and an illegal move throws `IllegalTransitionError` (→ 409).
 *
 * A line joins the board at QUEUED (routed at SENT, §5.5), advances forward as the
 * kitchen works it, and can bump back one step to correct a fat-fingered tap. VOID
 * is the terminal cancel (mirrors the per-item order void). SERVED is the terminal
 * done state.
 *
 * States (design §5.1):
 *
 *   QUEUED    — routed, waiting to be started. Initial state on the board.
 *   PREPARING — the kitchen has begun.
 *   READY     — plated / poured, waiting to be run to the table.
 *   SERVED    — delivered. Terminal.
 *   VOID      — cancelled item. Terminal.
 */

import { defineStateMachine, type StateMachine } from '@brewsync/shared'

/** Mirrors the Prisma `KdsStatus` enum; a string union so the machine is DB-free. */
export type KdsStatus = 'QUEUED' | 'PREPARING' | 'READY' | 'SERVED' | 'VOID'

export const kdsStateMachine: StateMachine<KdsStatus> = defineStateMachine<KdsStatus>({
  name: 'Kds',
  initial: 'QUEUED',
  transitions: {
    // Start prep, or void before touching it. (No bump-back — nothing precedes it.)
    QUEUED: ['PREPARING', 'VOID'],
    // Advance to ready, bump back to queue (mistap), or void mid-prep.
    PREPARING: ['READY', 'QUEUED', 'VOID'],
    // Run it out, or bump back to prep (sent out too early).
    READY: ['SERVED', 'PREPARING'],
    SERVED: [],
    VOID: [],
  },
})
