import type { ReactNode } from 'react'
import { Money } from '@brewsync/shared'

/**
 * Renders a minor-unit decimal string as formatted currency. The single place a
 * price string becomes display text on this app; keeps `Money.format` out of the
 * JSX so screens read cleanly. Never used for a payable total the server owns —
 * those are already formatted by the same helper on the confirmation screen.
 */
export function MoneyText({ amount }: { amount: string }): ReactNode {
  return <>{Money.format(Money.of(amount))}</>
}
