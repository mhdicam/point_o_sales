/**
 * Modifiers screen — S3-07, feature-gated behind `modifiers`. Modifier groups
 * with their options. A group's option priceDelta is signed minor units; it is
 * edited as a decimal string ("-1.00" for "no ice") and converted to minor units
 * at the edge (money-input; standard #2 — the FE never does money math).
 *
 * The whole route is also guarded by useFeature in the layout nav and by
 * requireFeature on the backend — this screen assumes the feature is on.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS } from '@brewsync/shared'
import {
  useModifiersStore,
  type GroupInput,
  type OptionInput,
} from '../stores/modifiers.store.ts'
import { usePermission } from '../hooks/usePermission.ts'
import { inputToMinor, minorToInput } from '../lib/money-input.ts'
import type { ModifierGroup, ModifierOption } from '../lib/types.ts'
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

export function ModifiersScreen(): ReactNode {
  const { groups, loading, error, list, createGroup, updateGroup, removeGroup, addOption, updateOption, removeOption } =
    useModifiersStore()
  const canEdit = usePermission(PERMISSIONS.PRODUCT_EDIT)

  const [groupForm, setGroupForm] = useState<{ open: boolean; group: ModifierGroup | null }>({
    open: false,
    group: null,
  })
  const [optionForm, setOptionForm] = useState<{
    open: boolean
    groupId: string
    option: ModifierOption | null
  } | null>(null)

  useEffect(() => {
    void list({ includeInactive: true })
  }, [list])

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Modifiers</h1>
        {canEdit ? (
          <Button onClick={() => setGroupForm({ open: true, group: null })}>New group</Button>
        ) : null}
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {loading && groups.length === 0 ? (
        <Spinner />
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState title="No modifier groups" hint="Create a group like “Milk” or “Size”." />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <section key={g.id} className="rounded-xl border border-line bg-surface">
              <header className="flex items-center gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-ink">{g.name}</span>
                    {g.isRequired ? <Badge tone="active">Required</Badge> : null}
                    {!g.isActive ? <Badge tone="muted">Inactive</Badge> : null}
                  </div>
                  <span className="text-xs text-ink-muted">
                    Select {g.minSelect}
                    {g.maxSelect === null ? '+' : `–${g.maxSelect}`}
                  </span>
                </div>
                {canEdit ? (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => setOptionForm({ open: true, groupId: g.id, option: null })}
                      className="h-9 px-3 text-xs"
                    >
                      Add option
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setGroupForm({ open: true, group: g })}
                      className="h-9 px-3 text-xs"
                    >
                      Edit
                    </Button>
                  </>
                ) : null}
              </header>
              <ul>
                {g.modifiers.length === 0 ? (
                  <li className="px-4 py-3 text-xs text-ink-muted">No options yet.</li>
                ) : (
                  g.modifiers.map((o) => (
                    <li
                      key={o.id}
                      className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm text-ink">{o.name}</span>
                          {o.isDefault ? <Badge tone="active">Default</Badge> : null}
                          {!o.isActive ? <Badge tone="muted">Inactive</Badge> : null}
                        </div>
                      </div>
                      <span className="shrink-0 text-sm tabular-nums text-ink-muted">
                        {o.priceDelta.startsWith('-') ? '' : '+'}
                        {minorToInput(o.priceDelta)}
                      </span>
                      {canEdit ? (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setOptionForm({ open: true, groupId: g.id, option: o })
                          }
                          className="h-9 px-3 text-xs"
                        >
                          Edit
                        </Button>
                      ) : null}
                    </li>
                  ))
                )}
              </ul>
            </section>
          ))}
        </div>
      )}

      {groupForm.open ? (
        <GroupForm
          group={groupForm.group}
          onClose={() => setGroupForm({ open: false, group: null })}
          onCreate={createGroup}
          onUpdate={updateGroup}
          onDelete={removeGroup}
        />
      ) : null}

      {optionForm?.open ? (
        <OptionForm
          groupId={optionForm.groupId}
          option={optionForm.option}
          onClose={() => setOptionForm(null)}
          onCreate={addOption}
          onUpdate={updateOption}
          onDelete={removeOption}
        />
      ) : null}
    </div>
  )
}

function GroupForm({
  group,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: {
  group: ModifierGroup | null
  onClose: () => void
  onCreate: (input: GroupInput) => Promise<ModifierGroup>
  onUpdate: (id: string, input: Partial<GroupInput>) => Promise<ModifierGroup>
  onDelete: (id: string) => Promise<void>
}): ReactNode {
  const isEdit = group !== null
  const [name, setName] = useState(group?.name ?? '')
  const [minSelect, setMinSelect] = useState(String(group?.minSelect ?? 0))
  const [maxSelect, setMaxSelect] = useState(group?.maxSelect === null || group === null ? '' : String(group.maxSelect))
  const [isRequired, setIsRequired] = useState(group?.isRequired ?? false)
  const [isActive, setIsActive] = useState(group?.isActive ?? true)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setSubmitError(null)
    setBusy(true)
    const input: GroupInput = {
      name: name.trim(),
      minSelect: Number(minSelect) || 0,
      maxSelect: maxSelect.trim() === '' ? null : Number(maxSelect),
      isRequired,
      isActive,
    }
    try {
      if (group) await onUpdate(group.id, input)
      else await onCreate(input)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to save group')
      setBusy(false)
    }
  }

  const del = async (): Promise<void> => {
    if (!group) return
    setBusy(true)
    try {
      await onDelete(group.id)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to delete group')
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
    <Modal title={isEdit ? 'Edit group' : 'New group'} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        {submitError ? <p className="text-sm text-danger">{submitError}</p> : null}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Milk" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Min select">
            <Input
              inputMode="numeric"
              value={minSelect}
              onChange={(e) => setMinSelect(e.target.value)}
            />
          </Field>
          <Field label="Max select (blank = unlimited)">
            <Input
              inputMode="numeric"
              value={maxSelect}
              onChange={(e) => setMaxSelect(e.target.value)}
            />
          </Field>
        </div>
        <Checkbox label="Required" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
        <Checkbox label="Active" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
      </div>
    </Modal>
  )
}

function OptionForm({
  groupId,
  option,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: {
  groupId: string
  option: ModifierOption | null
  onClose: () => void
  onCreate: (groupId: string, input: OptionInput) => Promise<ModifierOption>
  onUpdate: (optionId: string, input: Partial<OptionInput>) => Promise<ModifierOption>
  onDelete: (optionId: string) => Promise<void>
}): ReactNode {
  const isEdit = option !== null
  const [name, setName] = useState(option?.name ?? '')
  const [priceDelta, setPriceDelta] = useState(option ? minorToInput(option.priceDelta) : '0.00')
  const [isDefault, setIsDefault] = useState(option?.isDefault ?? false)
  const [isActive, setIsActive] = useState(option?.isActive ?? true)
  const [priceError, setPriceError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    const minor = inputToMinor(priceDelta)
    if (minor === null) {
      setPriceError('Invalid amount')
      return
    }
    setPriceError(null)
    setSubmitError(null)
    setBusy(true)
    const input: OptionInput = {
      name: name.trim(),
      priceDelta: minor,
      isDefault,
      isActive,
    }
    try {
      if (option) await onUpdate(option.id, input)
      else await onCreate(groupId, input)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to save option')
      setBusy(false)
    }
  }

  const del = async (): Promise<void> => {
    if (!option) return
    setBusy(true)
    try {
      await onDelete(option.id)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to delete option')
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
    <Modal title={isEdit ? 'Edit option' : 'New option'} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        {submitError ? <p className="text-sm text-danger">{submitError}</p> : null}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Oat milk" />
        </Field>
        <Field label="Price delta (signed)" error={priceError ?? undefined}>
          <Input
            inputMode="decimal"
            value={priceDelta}
            onChange={(e) => setPriceDelta(e.target.value)}
            placeholder="-1.00"
          />
        </Field>
        <Checkbox label="Default" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        <Checkbox label="Active" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
      </div>
    </Modal>
  )
}
