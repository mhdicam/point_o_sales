/**
 * Landing admin screen — S9-02, design §17.1. The CMS surface for the tenant's
 * single public landing page: edit page meta, add/edit/reorder/remove sections,
 * and publish/unpublish. Reorder is up/down buttons (drag is deferred); the
 * whole list is sent to the API, which owns the position invariant.
 *
 * No motion library is imported here — that lives in apps/landing only, so the
 * cashier bundle stays light. Per-type content editing is intentionally light:
 * CATALOG takes id references (it drives the live public catalog query); every
 * other type takes a free-form JSON object the public renderer consumes.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { PERMISSIONS } from '@brewsync/shared'
import { usePermission } from '../hooks/usePermission.ts'
import {
  useLandingStore,
  type AddSectionInput,
  type UpdateSectionInput,
} from '../stores/landing.store.ts'
import type { LandingPage, LandingSection, LandingSectionType } from '../lib/types.ts'
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
  Textarea,
} from '../ui/primitives.tsx'

const SECTION_TYPES: LandingSectionType[] = [
  'HERO',
  'CATALOG',
  'ABOUT',
  'GALLERY',
  'CONTACT',
  'HOURS',
  'MAP',
  'CUSTOM',
]

/** Splits a comma/newline separated list of ids into a trimmed, non-empty array. */
function parseIds(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function LandingAdminScreen(): ReactNode {
  const { page, loading, saving, error, load, updateMeta, publish, unpublish } = useLandingStore()
  const canManage = usePermission(PERMISSIONS.LANDING_MANAGE)

  const [editing, setEditing] = useState<LandingSection | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !page) return <Spinner />
  if (!page) return <ErrorBanner message={error ?? 'Landing page unavailable'} />

  return (
    <div className="flex flex-col gap-4">
      <Header
        page={page}
        canManage={canManage}
        saving={saving}
        onPublish={() => void publish()}
        onUnpublish={() => void unpublish()}
      />

      {error ? <ErrorBanner message={error} /> : null}

      <MetaCard page={page} canManage={canManage} saving={saving} onSave={updateMeta} />

      <SectionsCard
        page={page}
        canManage={canManage}
        onAdd={() => setAdding(true)}
        onEdit={(s) => setEditing(s)}
      />

      {adding ? <SectionModal onClose={() => setAdding(false)} /> : null}
      {editing ? <SectionModal section={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  )
}

function Header({
  page,
  canManage,
  saving,
  onPublish,
  onUnpublish,
}: {
  page: LandingPage
  canManage: boolean
  saving: boolean
  onPublish: () => void
  onUnpublish: () => void
}): ReactNode {
  const published = page.status === 'PUBLISHED'
  return (
    <header className="flex flex-wrap items-center gap-3">
      <h1 className="text-lg font-semibold text-ink">Landing page</h1>
      <Badge tone={published ? 'active' : 'muted'}>{page.status}</Badge>
      <a
        href={`/p/${page.slug}`}
        target="_blank"
        rel="noreferrer"
        className="text-sm text-brand underline"
      >
        /p/{page.slug}
      </a>
      {canManage ? (
        <div className="ml-auto flex gap-2">
          {published ? (
            <Button variant="secondary" onClick={onUnpublish} disabled={saving}>
              Unpublish
            </Button>
          ) : null}
          <Button onClick={onPublish} disabled={saving}>
            {published ? 'Re-publish' : 'Publish'}
          </Button>
        </div>
      ) : null}
    </header>
  )
}

function MetaCard({
  page,
  canManage,
  saving,
  onSave,
}: {
  page: LandingPage
  canManage: boolean
  saving: boolean
  onSave: (input: {
    title?: string
    description?: string | null
    orderingEnabled?: boolean
  }) => Promise<void>
}): ReactNode {
  const [title, setTitle] = useState(page.title)
  const [description, setDescription] = useState(page.description ?? '')
  const [orderingEnabled, setOrderingEnabled] = useState(page.orderingEnabled)

  const dirty =
    title !== page.title ||
    description !== (page.description ?? '') ||
    orderingEnabled !== page.orderingEnabled

  const save = (): void => {
    void onSave({
      title: title.trim(),
      description: description.trim() === '' ? null : description.trim(),
      orderingEnabled,
    })
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">Page details</h2>
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={!canManage} />
      </Field>
      <Field label="Description">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!canManage}
          placeholder="Shown under the page title on the public page."
        />
      </Field>
      <Checkbox
        label="Enable online ordering from this page"
        checked={orderingEnabled}
        onChange={(e) => setOrderingEnabled(e.target.checked)}
        disabled={!canManage}
      />
      {canManage ? (
        <div>
          <Button onClick={save} disabled={saving || !dirty || title.trim() === ''}>
            {saving ? 'Saving…' : 'Save details'}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function SectionsCard({
  page,
  canManage,
  onAdd,
  onEdit,
}: {
  page: LandingPage
  canManage: boolean
  onAdd: () => void
  onEdit: (section: LandingSection) => void
}): ReactNode {
  const { saving, reorder, removeSection } = useLandingStore()
  const sections = page.sections

  // Move a section by one slot, then renumber the whole list 0..n-1 and send it.
  const move = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= sections.length) return
    const next = [...sections]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    void reorder(next.map((s, position) => ({ id: s.id, position })))
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Sections</h2>
        {canManage ? (
          <Button onClick={onAdd} className="h-9 px-3 text-xs">
            Add section
          </Button>
        ) : null}
      </div>

      {sections.length === 0 ? (
        <EmptyState title="No sections yet" hint="Add a section to build the page." />
      ) : (
        <ul className="flex flex-col gap-2">
          {sections.map((s, index) => (
            <li
              key={s.id}
              className="flex items-center gap-3 rounded-lg border border-line px-3 py-2"
            >
              <div className="flex flex-col">
                <button
                  type="button"
                  aria-label="Move up"
                  onClick={() => move(index, -1)}
                  disabled={!canManage || saving || index === 0}
                  className="text-ink-muted disabled:opacity-30"
                >
                  ▲
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  onClick={() => move(index, 1)}
                  disabled={!canManage || saving || index === sections.length - 1}
                  className="text-ink-muted disabled:opacity-30"
                >
                  ▼
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge>{s.type}</Badge>
                  <span className="truncate text-sm font-medium text-ink">
                    {s.title ?? '(untitled)'}
                  </span>
                  {!s.isVisible ? <Badge tone="muted">Hidden</Badge> : null}
                </div>
              </div>
              {canManage ? (
                <>
                  <Button variant="secondary" onClick={() => onEdit(s)} className="h-9 px-3 text-xs">
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => void removeSection(s.id)}
                    disabled={saving}
                    className="h-9 px-3 text-xs"
                  >
                    Remove
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function SectionModal({
  section,
  onClose,
}: {
  section?: LandingSection
  onClose: () => void
}): ReactNode {
  const { saving, addSection, updateSection } = useLandingStore()
  const isEdit = section !== undefined
  const type = section?.type ?? 'HERO'

  const [chosenType, setChosenType] = useState<LandingSectionType>(type)
  const activeType = isEdit ? type : chosenType

  const [title, setTitle] = useState(section?.title ?? '')
  const [isVisible, setIsVisible] = useState(section?.isVisible ?? true)

  const content = section?.content ?? {}
  const [categoryIds, setCategoryIds] = useState(
    Array.isArray(content['categoryIds']) ? (content['categoryIds'] as string[]).join('\n') : ''
  )
  const [productIds, setProductIds] = useState(
    Array.isArray(content['productIds']) ? (content['productIds'] as string[]).join('\n') : ''
  )
  const [contentJson, setContentJson] = useState(() =>
    isEdit && activeType !== 'CATALOG' ? JSON.stringify(content, null, 2) : ''
  )
  const [formError, setFormError] = useState<string | null>(null)

  const buildContent = (): Record<string, unknown> | null => {
    if (activeType === 'CATALOG') {
      const body: Record<string, unknown> = {}
      const cats = parseIds(categoryIds)
      const prods = parseIds(productIds)
      if (cats.length > 0) body['categoryIds'] = cats
      if (prods.length > 0) body['productIds'] = prods
      return body
    }
    const text = contentJson.trim()
    if (text === '') return {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setFormError('Content must be a JSON object')
        return null
      }
      return parsed as Record<string, unknown>
    } catch {
      setFormError('Content is not valid JSON')
      return null
    }
  }

  const submit = async (): Promise<void> => {
    setFormError(null)
    const built = buildContent()
    if (built === null) return
    const base = { title: title.trim() === '' ? null : title.trim(), content: built, isVisible }
    try {
      if (section) {
        await updateSection(section.id, base satisfies UpdateSectionInput)
      } else {
        await addSection({ type: activeType, ...base } satisfies AddSectionInput)
      }
      onClose()
    } catch {
      // The store already surfaced the error into its banner; keep the modal open.
    }
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={saving}>
        Cancel
      </Button>
      <Button onClick={() => void submit()} disabled={saving}>
        {saving ? 'Saving…' : isEdit ? 'Save' : 'Add section'}
      </Button>
    </>
  )

  return (
    <Modal title={isEdit ? 'Edit section' : 'Add section'} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        {formError ? <p className="text-sm text-danger">{formError}</p> : null}
        <Field label="Type">
          {isEdit ? (
            <Badge>{activeType}</Badge>
          ) : (
            <Select
              value={chosenType}
              onChange={(e) => setChosenType(e.target.value as LandingSectionType)}
            >
              {SECTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        {activeType === 'CATALOG' ? (
          <>
            <Field label="Category ids (one per line, optional)">
              <Textarea value={categoryIds} onChange={(e) => setCategoryIds(e.target.value)} />
            </Field>
            <Field label="Product ids (one per line, optional)">
              <Textarea value={productIds} onChange={(e) => setProductIds(e.target.value)} />
            </Field>
          </>
        ) : (
          <Field label="Content (JSON object)">
            <Textarea
              value={contentJson}
              onChange={(e) => setContentJson(e.target.value)}
              placeholder={'{\n  "body": "…"\n}'}
              className="font-mono text-xs"
              rows={6}
            />
          </Field>
        )}

        <Checkbox
          label="Visible on the published page"
          checked={isVisible}
          onChange={(e) => setIsVisible(e.target.checked)}
        />
      </div>
    </Modal>
  )
}

