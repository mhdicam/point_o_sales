/**
 * Categories screen — S3-07. A nested category tree (indented by depth) with
 * inline create/edit. The parent picker excludes the node itself and its
 * descendants so the UI never offers a cycle the backend would reject
 * (descendantIds; UX only — standard #5).
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS } from '@brewsync/shared'
import {
  useCategoriesStore,
  type CategoryInput,
} from '../stores/categories.store.ts'
import { usePermission } from '../hooks/usePermission.ts'
import {
  buildCategoryTree,
  descendantIds,
  flattenTree,
} from '../lib/category-tree.ts'
import type { Category } from '../lib/types.ts'
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

interface Draft {
  name: string
  slug: string
  parentId: string | null
  isActive: boolean
}

function draftFrom(category: Category | null): Draft {
  return {
    name: category?.name ?? '',
    slug: category?.slug ?? '',
    parentId: category?.parentId ?? null,
    isActive: category?.isActive ?? true,
  }
}

export function CategoriesScreen(): ReactNode {
  const { items, loading, error, list, create, update, remove } = useCategoriesStore()
  const canEdit = usePermission(PERMISSIONS.PRODUCT_EDIT)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Category | null>(null)

  useEffect(() => {
    void list({ includeInactive: true })
  }, [list])

  const ordered = useMemo(() => flattenTree(buildCategoryTree(items)), [items])

  const openCreate = (): void => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (c: Category): void => {
    setEditing(c)
    setFormOpen(true)
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Categories</h1>
        {canEdit ? <Button onClick={openCreate}>New category</Button> : null}
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="rounded-xl border border-line bg-surface">
        {loading && items.length === 0 ? (
          <Spinner />
        ) : ordered.length === 0 ? (
          <EmptyState title="No categories" hint="Create a category to organize the menu." />
        ) : (
          <ul>
            {ordered.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1" style={{ paddingLeft: `${c.depth * 20}px` }}>
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{c.name}</span>
                    {!c.isActive ? <Badge tone="muted">Inactive</Badge> : null}
                  </div>
                  <span className="text-xs text-ink-muted">{c.slug}</span>
                </div>
                {canEdit ? (
                  <Button
                    variant="secondary"
                    onClick={() => openEdit(c)}
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
        <CategoryForm
          category={editing}
          categories={items}
          onClose={() => setFormOpen(false)}
          onCreate={create}
          onUpdate={update}
          onDelete={remove}
        />
      ) : null}
    </div>
  )
}

function CategoryForm({
  category,
  categories,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: {
  category: Category | null
  categories: Category[]
  onClose: () => void
  onCreate: (input: CategoryInput) => Promise<Category>
  onUpdate: (id: string, input: Partial<CategoryInput>) => Promise<Category>
  onDelete: (id: string) => Promise<void>
}): ReactNode {
  const isEdit = category !== null
  const [draft, setDraft] = useState<Draft>(() => draftFrom(category))
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Parent options exclude self + descendants (cycle prevention, UX only).
  const blocked = useMemo(
    () => (category ? descendantIds(categories, category.id) : new Set<string>()),
    [categories, category]
  )
  const parentOptions = useMemo(
    () => flattenTree(buildCategoryTree(categories)).filter((c) => !blocked.has(c.id)),
    [categories, blocked]
  )

  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))

  const submit = async (): Promise<void> => {
    setSubmitError(null)
    setBusy(true)
    const input: CategoryInput = {
      name: draft.name.trim(),
      slug: draft.slug.trim(),
      parentId: draft.parentId,
      isActive: draft.isActive,
    }
    try {
      if (category) await onUpdate(category.id, input)
      else await onCreate(input)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to save category')
      setBusy(false)
    }
  }

  const del = async (): Promise<void> => {
    if (!category) return
    setSubmitError(null)
    setBusy(true)
    try {
      await onDelete(category.id)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to delete category')
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
    <Modal title={isEdit ? 'Edit category' : 'New category'} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        {submitError ? <p className="text-sm text-danger">{submitError}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Slug">
            <Input value={draft.slug} onChange={(e) => set({ slug: e.target.value })} />
          </Field>
        </div>
        <Field label="Parent category">
          <Select
            value={draft.parentId ?? ''}
            onChange={(e) => set({ parentId: e.target.value || null })}
          >
            <option value="">No parent (top level)</option>
            {parentOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {`${'  '.repeat(c.depth)}${c.name}`}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox
          label="Active"
          checked={draft.isActive}
          onChange={(e) => set({ isActive: e.target.checked })}
        />
      </div>
    </Modal>
  )
}
