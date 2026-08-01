/**
 * Price lists screen — S3-07, guarded by price.edit. Edits price-list metadata
 * (name, priority, validity window, active). Per-variant item overrides are set
 * in bulk via PUT .../items — a heavier editor deferred beyond S3-07's master
 * CRUD scope; the store exposes setItems for when that screen is built.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS } from '@brewsync/shared'
import { usePricesStore, type PriceListInput } from '../stores/prices.store.ts'
import { usePermission } from '../hooks/usePermission.ts'
import type { PriceList } from '../lib/types.ts'
import { Modal } from '../ui/Modal.tsx'
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Spinner,
} from '../ui/primitives.tsx'

interface Draft {
  name: string
  priority: string
  validFrom: string
  validTo: string
  isActive: boolean
}

function draftFrom(list: PriceList | null): Draft {
  return {
    name: list?.name ?? '',
    priority: String(list?.priority ?? 0),
    validFrom: list?.validFrom?.slice(0, 10) ?? '',
    validTo: list?.validTo?.slice(0, 10) ?? '',
    isActive: list?.isActive ?? true,
  }
}

export function PriceListsScreen(): ReactNode {
  const { lists, loading, error, list, create, update, remove } = usePricesStore()
  const canEdit = usePermission(PERMISSIONS.PRICE_EDIT)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<PriceList | null>(null)

  useEffect(() => {
    void list({ includeInactive: true })
  }, [list])

  const openCreate = (): void => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (l: PriceList): void => {
    setEditing(l)
    setFormOpen(true)
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Price lists</h1>
        {canEdit ? <Button onClick={openCreate}>New price list</Button> : null}
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="rounded-xl border border-line bg-surface">
        {loading && lists.length === 0 ? (
          <Spinner />
        ) : lists.length === 0 ? (
          <EmptyState title="No price lists" hint="Create a price list to override variant prices." />
        ) : (
          <ul>
            {lists.map((l) => (
              <li
                key={l.id}
                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{l.name}</span>
                    {!l.isActive ? <Badge tone="muted">Inactive</Badge> : null}
                  </div>
                  <span className="text-xs text-ink-muted">
                    Priority {l.priority}
                    {l.salesMethod ? ` · ${l.salesMethod}` : ''}
                    {l.validFrom ? ` · from ${l.validFrom.slice(0, 10)}` : ''}
                    {l.validTo ? ` · to ${l.validTo.slice(0, 10)}` : ''}
                  </span>
                </div>
                {canEdit ? (
                  <Button
                    variant="secondary"
                    onClick={() => openEdit(l)}
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
        <PriceListForm
          list={editing}
          onClose={() => setFormOpen(false)}
          onCreate={create}
          onUpdate={update}
          onDelete={remove}
        />
      ) : null}
    </div>
  )
}

function PriceListForm({
  list,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: {
  list: PriceList | null
  onClose: () => void
  onCreate: (input: PriceListInput) => Promise<PriceList>
  onUpdate: (id: string, input: Partial<PriceListInput>) => Promise<PriceList>
  onDelete: (id: string) => Promise<void>
}): ReactNode {
  const isEdit = list !== null
  const [draft, setDraft] = useState<Draft>(() => draftFrom(list))
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))

  const submit = async (): Promise<void> => {
    setSubmitError(null)
    setBusy(true)
    const input: PriceListInput = {
      name: draft.name.trim(),
      priority: Number(draft.priority) || 0,
      validFrom: draft.validFrom.trim() === '' ? null : draft.validFrom,
      validTo: draft.validTo.trim() === '' ? null : draft.validTo,
      isActive: draft.isActive,
    }
    try {
      if (list) await onUpdate(list.id, input)
      else await onCreate(input)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to save price list')
      setBusy(false)
    }
  }

  const del = async (): Promise<void> => {
    if (!list) return
    setBusy(true)
    try {
      await onDelete(list.id)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to delete price list')
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
    <Modal title={isEdit ? 'Edit price list' : 'New price list'} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        {submitError ? <p className="text-sm text-danger">{submitError}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Priority">
            <Input
              inputMode="numeric"
              value={draft.priority}
              onChange={(e) => set({ priority: e.target.value })}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Valid from">
            <Input type="date" value={draft.validFrom} onChange={(e) => set({ validFrom: e.target.value })} />
          </Field>
          <Field label="Valid to">
            <Input type="date" value={draft.validTo} onChange={(e) => set({ validTo: e.target.value })} />
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
