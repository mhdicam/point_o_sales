/**
 * Units screen — S3-07. Units of measure with a create/edit form. `factor` is a
 * plain decimal string the backend parses (× 1e6 BigInt on the wire); the form
 * passes it through untouched. Base units (no baseUnitId) anchor a dimension;
 * derived units reference a base and carry a factor.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS } from '@brewsync/shared'
import { useUnitsStore, type UnitInput } from '../stores/units.store.ts'
import { usePermission } from '../hooks/usePermission.ts'
import type { Unit, UnitDimension } from '../lib/types.ts'
import { Modal } from '../ui/Modal.tsx'
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Select,
  Spinner,
} from '../ui/primitives.tsx'

const DIMENSIONS: UnitDimension[] = ['COUNT', 'WEIGHT', 'VOLUME', 'LENGTH', 'TIME']

interface Draft {
  code: string
  name: string
  dimension: UnitDimension
  baseUnitId: string | null
  factor: string
  isActive: boolean
}

function draftFrom(unit: Unit | null): Draft {
  return {
    code: unit?.code ?? '',
    name: unit?.name ?? '',
    dimension: unit?.dimension ?? 'COUNT',
    baseUnitId: unit?.baseUnitId ?? null,
    factor: unit?.factor ?? '1',
    isActive: unit?.isActive ?? true,
  }
}

export function UnitsScreen(): ReactNode {
  const { items, loading, error, list, create, update, remove } = useUnitsStore()
  const canEdit = usePermission(PERMISSIONS.PRODUCT_EDIT)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Unit | null>(null)

  useEffect(() => {
    void list({ includeInactive: true })
  }, [list])

  const openCreate = (): void => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (u: Unit): void => {
    setEditing(u)
    setFormOpen(true)
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Units</h1>
        {canEdit ? <Button onClick={openCreate}>New unit</Button> : null}
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="rounded-xl border border-line bg-surface">
        {loading && items.length === 0 ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="No units" hint="Add a unit of measure to get started." />
        ) : (
          <ul>
            {items.map((u) => (
              <li
                key={u.id}
                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{u.name}</span>
                    <Badge>{u.code}</Badge>
                    {!u.isActive ? <Badge tone="muted">Inactive</Badge> : null}
                  </div>
                  <span className="text-xs text-ink-muted">
                    {u.dimension}
                    {u.baseUnitId ? ` · ×${u.factor}` : ' · base'}
                  </span>
                </div>
                {canEdit ? (
                  <Button
                    variant="secondary"
                    onClick={() => openEdit(u)}
                    className="h-9 px-3 text-xs"
                  >
                    Edit
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {formOpen ? (
        <UnitForm
          unit={editing}
          units={items}
          onClose={() => setFormOpen(false)}
          onCreate={create}
          onUpdate={update}
          onDelete={remove}
        />
      ) : null}
    </div>
  )
}

function UnitForm({
  unit,
  units,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: {
  unit: Unit | null
  units: Unit[]
  onClose: () => void
  onCreate: (input: UnitInput) => Promise<Unit>
  onUpdate: (id: string, input: Partial<UnitInput>) => Promise<Unit>
  onDelete: (id: string) => Promise<void>
}): ReactNode {
  const isEdit = unit !== null
  const [draft, setDraft] = useState<Draft>(() => draftFrom(unit))
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))

  // Base-unit candidates: same dimension, not this unit.
  const baseCandidates = useMemo(
    () => units.filter((u) => u.dimension === draft.dimension && u.id !== unit?.id),
    [units, draft.dimension, unit]
  )

  const submit = async (): Promise<void> => {
    setSubmitError(null)
    setBusy(true)
    const input: UnitInput = {
      code: draft.code.trim(),
      name: draft.name.trim(),
      dimension: draft.dimension,
      baseUnitId: draft.baseUnitId,
      factor: draft.factor.trim() || '1',
      isActive: draft.isActive,
    }
    try {
      if (unit) await onUpdate(unit.id, input)
      else await onCreate(input)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to save unit')
      setBusy(false)
    }
  }

  const del = async (): Promise<void> => {
    if (!unit) return
    setSubmitError(null)
    setBusy(true)
    try {
      await onDelete(unit.id)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to delete unit')
      setBusy(false)
    }
  }

  const footer = (
    <>
      {isEdit ? (
        <Button variant="danger" onClick={del} disabled={busy} className="mr-auto">
          Delete
        </Button>
      ) : null}
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button onClick={submit} disabled={busy}>
        {busy ? 'Saving…' : isEdit ? 'Save' : 'Create'}
      </Button>
    </>
  )

  return (
    <Modal title={isEdit ? 'Edit unit' : 'New unit'} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        {submitError ? <p className="text-sm text-danger">{submitError}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code">
            <Input value={draft.code} onChange={(e) => set({ code: e.target.value })} placeholder="kg" />
          </Field>
          <Field label="Name">
            <Input
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Kilogram"
            />
          </Field>
        </div>
        <Field label="Dimension">
          <Select
            value={draft.dimension}
            onChange={(e) =>
              set({ dimension: e.target.value as UnitDimension, baseUnitId: null })
            }
          >
            {DIMENSIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Base unit">
            <Select
              value={draft.baseUnitId ?? ''}
              onChange={(e) => set({ baseUnitId: e.target.value || null })}
            >
              <option value="">None (this is a base unit)</option>
              {baseCandidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Factor (per base unit)">
            <Input
              inputMode="decimal"
              value={draft.factor}
              onChange={(e) => set({ factor: e.target.value })}
              disabled={draft.baseUnitId === null}
              placeholder="1000"
            />
          </Field>
        </div>
        <Checkbox
          label="Active"
          checked={draft.isActive}
          onChange={(e) => set({ isActive: e.target.checked })}
        />
      </div>
    </Modal>
  )
}
