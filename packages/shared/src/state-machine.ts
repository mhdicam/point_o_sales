/**
 * Explicit state machines — standard #6, sprint plan §4.
 *
 * Order, PurchaseOrder, Reservation, and Shift all need transition validation.
 * Rather than four hand-rolled `switch` statements that drift apart, transitions
 * are declared as data and checked here. An illegal transition throws; it is
 * never silently accepted.
 */

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION'

  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
    readonly allowed: readonly string[]
  ) {
    super(
      `${machine}: cannot move from ${from} to ${to}. ` +
        (allowed.length > 0
          ? `Allowed from ${from}: ${allowed.join(', ')}.`
          : `${from} is a terminal state.`)
    )
    this.name = 'IllegalTransitionError'
  }
}

export interface StateMachine<S extends string> {
  readonly name: string
  readonly initial: S
  readonly states: readonly S[]
  can(from: S, to: S): boolean
  assert(from: S, to: S): void
  next(from: S): readonly S[]
  isTerminal(state: S): boolean
}

export function defineStateMachine<S extends string>(config: {
  name: string
  initial: S
  transitions: Readonly<Record<S, readonly S[]>>
}): StateMachine<S> {
  const { name, initial, transitions } = config
  const states = Object.keys(transitions) as S[]

  // Catch a typo'd target state at module load rather than at 2am in production.
  for (const [from, targets] of Object.entries(transitions) as [S, readonly S[]][]) {
    for (const to of targets) {
      if (!(to in transitions)) {
        throw new Error(`${name}: transition ${from} → ${to} names an undeclared state.`)
      }
    }
  }

  const can = (from: S, to: S): boolean => (transitions[from] ?? []).includes(to)

  return {
    name,
    initial,
    states,
    can,
    assert(from: S, to: S): void {
      if (!can(from, to)) {
        throw new IllegalTransitionError(name, from, to, transitions[from] ?? [])
      }
    },
    next: (from: S) => transitions[from] ?? [],
    isTerminal: (state: S) => (transitions[state] ?? []).length === 0,
  }
}
