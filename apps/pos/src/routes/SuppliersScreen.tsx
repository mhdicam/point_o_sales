/**
 * Suppliers screen — S6-05, feature-gated behind `purchasing` and the
 * `supplier.manage` permission. A flat list of vendors with a create/edit modal.
 * `code` is set once and frozen (PO history looks a supplier up by it), so it is
 * read-only in edit mode. Delete deactivates rather than removes.
 *
 * The route is also guarded by useFeature in the layout nav and by requireFeature
 * on the backend — this screen assumes the feature is on.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS } from '@brewsync/shared'
import {
  useSuppliersStore,
  type SupplierInput,
  type SupplierUpdate,
} from '../stores/suppliers.store.ts'
import { usePermission } from '../hooks/usePermission.ts'
import type { Supplier } from '../lib/types.ts'
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
  Textarea,
} from '../ui/primitives.tsx'

export function SuppliersScreen(): ReactNode {
  const { suppliers, loading, error, list, create, update, deactivate } = useSuppliersStore()
  const canEdit = usePermission(PERMISSIONS.SUPPLIER_MANAGE)

  const [form, setForm] = useState<{ open: boolean; supplier: Supplier | null }>({
    open: false,
    supplier: null,
  })

  useEffect(() => {
    void list({ includeInactive: true })
  }, [list])

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Suppliers</h1>
        {canEdit ? (
          <Button onClick={() => setForm({ open: true, supplier: null })}>New supplier</Button>
        ) : null}
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {loading && suppliers.length === 0 ? (
        <Spinner />
      ) : suppliers.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState title="No suppliers" hint="Register a vendor to raise purchase orders against." />
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-surface">
          <ul>
            {suppliers.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-ink">{s.name}</span>
                    <Badge tone="muted">{s.code}</Badge>
                    {!s.isActive ? <Badge tone="muted">Inactive</Badge> : null}
                  </div>
                  <span className="text-xs text-ink-muted">
                    {s.contactName ? `${s.contactName} · ` : ''}
                    {s.phone ?? s.email ?? '—'}
                    {s.paymentTermDays > 0 ? ` · net-${s.paymentTermDays}` : ' · cash'}
                  </span>
                </div>
                {canEdit ? (
                  <Button
                    variant="ghost"
                    onClick={() => setForm({ open: true, supplier: s })}
                    className="h-9 px-3 text-xs"
                  >
                    Edit
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {form.open ? (
        <SupplierForm
          supplier={form.supplier}
          onClose={() => setForm({ open: false, supplier: null })}
          onCreate={create}
          onUpdate={update}
          onDeactivate={deactivate}
        />
      ) : null}
    </div>
  )
}

function SupplierForm({
  supplier,
  onClose,
  onCreate,
  onUpdate,
  onDeactivate,
}: {
  supplier: Supplier | null
  onClose: () => void
  onCreate: (input: SupplierInput) => Promise<Supplier>
  onUpdate: (id: string, input: SupplierUpdate) => Promise<Supplier>
  onDeactivate: (id: string) => Promise<void>
}): ReactNode {
  const isEdit = supplier !== null
  const [code, setCode] = useState(supplier?.code ?? '')
  const [name, setName] = useState(supplier?.name ?? '')
  const [contactName, setContactName] = useState(supplier?.contactName ?? '')
  const [phone, setPhone] = useState(supplier?.phone ?? '')
  const [email, setEmail] = useState(supplier?.email ?? '')
  const [address, setAddress] = useState(supplier?.address ?? '')
  const [taxId, setTaxId] = useState(supplier?.taxId ?? '')
  const [paymentTermDays, setPaymentTermDays] = useState(String(supplier?.paymentTermDays ?? 0))
  const [notes, setNotes] = useState(supplier?.notes ?? '')
  const [isActive, setIsActive] = useState(supplier?.isActive ?? true)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setSubmitError(null)
    setBusy(true)
    const base = {
      name: name.trim(),
      contactName: contactName.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      address: address.trim() || null,
      taxId: taxId.trim() || null,
      paymentTermDays: Number(paymentTermDays) || 0,
      isActive,
      notes: notes.trim() || null,
    }
    try {
      if (supplier) await onUpdate(supplier.id, base)
      else await onCreate({ ...base, code: code.trim() })
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to save supplier')
      setBusy(false)
    }
  }

  const deact = async (): Promise<void> => {
    if (!supplier) return
    setBusy(true)
    try {
      await onDeactivate(supplier.id)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to deactivate supplier')
      setBusy(false)
    }
  }

  const footer = (
    <>
      {isEdit && supplier?.isActive ? (
        <Button variant="danger" onClick={deact} disabled={busy} className="mr-auto">
          Deactivate
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
    <Modal title={isEdit ? 'Edit supplier' : 'New supplier'} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        {submitError ? <p className="text-sm text-danger">{submitError}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ACME"
              disabled={isEdit}
            />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Roasters" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact name">
            <Input value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
          </Field>
        </div>
        <Field label="Email">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" />
        </Field>
        <Field label="Address">
          <Textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={2} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tax ID (NPWP)">
            <Input value={taxId} onChange={(e) => setTaxId(e.target.value)} />
          </Field>
          <Field label="Payment term (days)">
            <Input
              inputMode="numeric"
              value={paymentTermDays}
              onChange={(e) => setPaymentTermDays(e.target.value)}
              placeholder="0"
            />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
        <Checkbox label="Active" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
      </div>
    </Modal>
  )
}
