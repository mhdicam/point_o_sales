/**
 * Product form — create/edit a product with its variants and images, inside the
 * Modal. Validation and payload assembly live in lib/product-form.ts (pure,
 * tested); this component is the controlled-input shell around them.
 *
 * Prices are edited as major-unit decimals ("12.50") and converted to minor
 * units only at submit (standard #2: the FE never does money math). On edit,
 * product-level fields go through PUT /products/:id via buildUpdatePayload;
 * variant/image editing beyond the top level is out of S3-07 scope.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { FULFILLMENT_TYPES, type FulfillmentType } from '@brewsync/shared'
import {
  buildCreatePayload,
  buildUpdatePayload,
  hasErrors,
  validateProductDraft,
  type ProductDraft,
  type ProductFormErrors,
  type VariantDraft,
} from '../../lib/product-form.ts'
import { minorToInput } from '../../lib/money-input.ts'
import { buildCategoryTree, flattenTree } from '../../lib/category-tree.ts'
import type { Category, Product } from '../../lib/types.ts'
import { Modal } from '../../ui/Modal.tsx'
import {
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
} from '../../ui/primitives.tsx'

const FULFILLMENT_LABEL: Record<FulfillmentType, string> = {
  STOCKED: 'Stocked',
  MADE_TO_ORDER: 'Made to order',
  SERVICE: 'Service',
}

function emptyVariant(sortOrder: number, isDefault: boolean): VariantDraft {
  return { sku: '', name: '', barcode: '', basePrice: '', isDefault, sortOrder }
}

function draftFromProduct(product: Product): ProductDraft {
  return {
    name: product.name,
    slug: product.slug,
    description: product.description ?? '',
    categoryId: product.categoryId,
    fulfillmentType: product.fulfillmentType,
    variants: product.variants.map((v, i) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      barcode: v.barcode ?? '',
      basePrice: minorToInput(v.basePrice),
      isDefault: v.isDefault,
      sortOrder: v.sortOrder || i,
    })),
    images: product.images.map((img, i) => ({
      id: img.id,
      url: img.url,
      alt: img.alt ?? '',
      isCover: img.isCover,
      sortOrder: img.sortOrder || i,
    })),
  }
}

function emptyDraft(): ProductDraft {
  return {
    name: '',
    slug: '',
    description: '',
    categoryId: null,
    fulfillmentType: 'STOCKED',
    variants: [emptyVariant(0, true)],
    images: [],
  }
}

export function ProductForm({
  product,
  categories,
  onClose,
  onSubmit,
}: {
  /** Present when editing; absent when creating. */
  product: Product | null
  categories: Category[]
  onClose: () => void
  onSubmit: (draft: ProductDraft) => Promise<void>
}): ReactNode {
  const isEdit = product !== null
  const [draft, setDraft] = useState<ProductDraft>(() =>
    product ? draftFromProduct(product) : emptyDraft()
  )
  const [errors, setErrors] = useState<ProductFormErrors>({ variantRows: {} })
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const categoryOptions = useMemo(() => flattenTree(buildCategoryTree(categories)), [categories])

  const set = (patch: Partial<ProductDraft>): void => setDraft((d) => ({ ...d, ...patch }))

  const setVariant = (index: number, patch: Partial<VariantDraft>): void =>
    setDraft((d) => ({
      ...d,
      variants: d.variants.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    }))

  const setDefaultVariant = (index: number): void =>
    setDraft((d) => ({
      ...d,
      variants: d.variants.map((v, i) => ({ ...v, isDefault: i === index })),
    }))

  const addVariant = (): void =>
    setDraft((d) => ({
      ...d,
      variants: [...d.variants, emptyVariant(d.variants.length, d.variants.length === 0)],
    }))

  const removeVariant = (index: number): void =>
    setDraft((d) => {
      const variants = d.variants.filter((_, i) => i !== index)
      // Keep exactly one default alive.
      if (variants.length > 0 && !variants.some((v) => v.isDefault) && variants[0]) {
        variants[0] = { ...variants[0], isDefault: true }
      }
      return { ...d, variants }
    })

  const handleSubmit = async (): Promise<void> => {
    const found = validateProductDraft(draft)
    setErrors(found)
    if (hasErrors(found)) return
    setSubmitError(null)
    setBusy(true)
    try {
      await onSubmit(draft)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to save product')
      setBusy(false)
    }
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button onClick={handleSubmit} disabled={busy}>
        {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create product'}
      </Button>
    </>
  )

  return (
    <Modal title={isEdit ? 'Edit product' : 'New product'} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">
        {submitError ? <p className="text-sm text-danger">{submitError}</p> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name}>
            <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Slug" error={errors.slug}>
            <Input value={draft.slug} onChange={(e) => set({ slug: e.target.value })} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category">
            <Select
              value={draft.categoryId ?? ''}
              onChange={(e) => set({ categoryId: e.target.value || null })}
            >
              <option value="">No category</option>
              {categoryOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {`${'  '.repeat(c.depth)}${c.name}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fulfillment">
            <Select
              value={draft.fulfillmentType}
              onChange={(e) => set({ fulfillmentType: e.target.value as FulfillmentType })}
            >
              {FULFILLMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FULFILLMENT_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Description">
          <Textarea
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Variants</h3>
            <Button variant="secondary" onClick={addVariant} className="h-9 px-3 text-xs">
              Add variant
            </Button>
          </div>
          {errors.variants ? <p className="text-xs text-danger">{errors.variants}</p> : null}

          <div className="flex flex-col gap-3">
            {draft.variants.map((v, i) => {
              const row = errors.variantRows[i] ?? {}
              return (
                <div key={v.id ?? i} className="rounded-lg border border-line p-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="SKU" error={row.sku}>
                      <Input value={v.sku} onChange={(e) => setVariant(i, { sku: e.target.value })} />
                    </Field>
                    <Field label="Variant name" error={row.name}>
                      <Input
                        value={v.name}
                        onChange={(e) => setVariant(i, { name: e.target.value })}
                      />
                    </Field>
                    <Field label="Price" error={row.basePrice}>
                      <Input
                        inputMode="decimal"
                        value={v.basePrice}
                        onChange={(e) => setVariant(i, { basePrice: e.target.value })}
                        placeholder="0.00"
                      />
                    </Field>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <Checkbox
                      label="Default variant"
                      checked={v.isDefault}
                      onChange={() => setDefaultVariant(i)}
                    />
                    {draft.variants.length > 1 ? (
                      <Button
                        variant="ghost"
                        onClick={() => removeVariant(i)}
                        className="h-9 px-3 text-xs text-danger"
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </Modal>
  )
}

/** Assemble and dispatch the right payload for the draft. Shared by the screen. */
export async function submitProductDraft(
  draft: ProductDraft,
  product: Product | null,
  create: (payload: ReturnType<typeof buildCreatePayload>) => Promise<unknown>,
  update: (id: string, payload: ReturnType<typeof buildUpdatePayload>) => Promise<unknown>
): Promise<void> {
  if (product) {
    await update(product.id, buildUpdatePayload(draft))
  } else {
    await create(buildCreatePayload(draft))
  }
}
