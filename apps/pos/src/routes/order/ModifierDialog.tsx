/**
 * ModifierDialog — collects modifier choices before a line is added (design §3.1).
 *
 * Shown only when a tapped product has attached modifier groups and the
 * `modifiers` feature is on. It enforces each group's min/max selection rules on
 * the FE for good UX; the backend re-resolves and re-validates the chosen ids at
 * add and refreezes their deltas at SENT (standard #5/#7), so this is not the
 * integrity boundary. Emits the flat `modifierIds` the add-item route expects.
 *
 * priceDelta is display-only here (signed, pre-formatted at the edge) — the line
 * price is computed server-side once the item is added.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '../../ui/Modal.tsx'
import { Button } from '../../ui/primitives.tsx'
import { minorToInput } from '../../lib/money-input.ts'
import type { ModifierGroup } from '../../lib/types.ts'

function deltaLabel(priceDelta: string): string {
  if (priceDelta === '0' || priceDelta === '') return ''
  const sign = priceDelta.startsWith('-') ? '−' : '+'
  const magnitude = priceDelta.replace(/^-/, '')
  return ` (${sign}${minorToInput(magnitude, 2)})`
}

export function ModifierDialog({
  productName,
  groups,
  busy,
  onClose,
  onConfirm,
}: {
  productName: string
  groups: ModifierGroup[]
  busy: boolean
  onClose: () => void
  onConfirm: (modifierIds: string[]) => void
}): ReactNode {
  // Seed with each group's default options so the common case is one tap.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const seed = new Set<string>()
    for (const g of groups) {
      for (const m of g.modifiers) if (m.isDefault) seed.add(m.id)
    }
    return seed
  })

  const toggle = (group: ModifierGroup, optionId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(optionId)) {
        next.delete(optionId)
        return next
      }
      const chosenInGroup = group.modifiers.filter((m) => next.has(m.id)).length
      const max = group.maxSelect
      if (max === 1) {
        // Single-select: replace the current choice in this group.
        for (const m of group.modifiers) next.delete(m.id)
      } else if (max !== null && chosenInGroup >= max) {
        return prev // at the cap; ignore
      }
      next.add(optionId)
      return next
    })
  }

  const unmet = useMemo(
    () =>
      groups
        .filter((g) => {
          const count = g.modifiers.filter((m) => selected.has(m.id)).length
          if (g.isRequired && count < Math.max(1, g.minSelect)) return true
          if (count < g.minSelect) return true
          return false
        })
        .map((g) => g.name),
    [groups, selected]
  )

  const confirm = (): void => {
    if (unmet.length > 0) return
    onConfirm([...selected])
  }

  return (
    <Modal
      title={productName}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={busy || unmet.length > 0}>
            Add to order
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {groups.map((group) => {
          const rule =
            group.maxSelect === 1
              ? 'Choose one'
              : group.maxSelect !== null
                ? `Choose up to ${group.maxSelect}`
                : group.minSelect > 0
                  ? `Choose at least ${group.minSelect}`
                  : 'Optional'
          return (
            <fieldset key={group.id} className="flex flex-col gap-2">
              <legend className="flex items-center gap-2 text-sm font-medium text-ink">
                {group.name}
                <span className="text-xs font-normal text-ink-muted">
                  {rule}
                  {group.isRequired ? ' · required' : ''}
                </span>
              </legend>
              <div className="flex flex-col gap-1">
                {group.modifiers.map((option) => {
                  const isSelected = selected.has(option.id)
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggle(group, option.id)}
                      className={`flex min-h-tap items-center justify-between rounded-lg border px-3 text-sm transition ${
                        isSelected
                          ? 'border-brand bg-brand/10 text-ink'
                          : 'border-line bg-surface text-ink-muted hover:bg-surface-muted'
                      }`}
                    >
                      <span>
                        {option.name}
                        <span className="text-ink-muted">{deltaLabel(option.priceDelta)}</span>
                      </span>
                      {isSelected ? <span className="text-brand">✓</span> : null}
                    </button>
                  )
                })}
              </div>
            </fieldset>
          )
        })}

        {unmet.length > 0 ? (
          <p className="text-xs text-danger">Please complete: {unmet.join(', ')}.</p>
        ) : null}
      </div>
    </Modal>
  )
}
