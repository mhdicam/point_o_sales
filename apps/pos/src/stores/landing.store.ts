/**
 * Landing CMS store — S9-02. Holds the single per-tenant landing page and its
 * sections, plus the mutations the admin screen drives. Every mutation returns
 * the whole page (the API always answers with the full `{ landing }`), so the
 * store just replaces its snapshot rather than patching sections locally — the
 * server owns position order and audit fields.
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { LandingPage, LandingSectionType } from '../lib/types.ts'

export interface UpdateMetaInput {
  title?: string
  description?: string | null
  theme?: Record<string, unknown> | null
  orderingEnabled?: boolean
}

export interface AddSectionInput {
  type: LandingSectionType
  title?: string | null
  content?: Record<string, unknown>
  isVisible?: boolean
}

export interface UpdateSectionInput {
  title?: string | null
  content?: Record<string, unknown>
  isVisible?: boolean
}

interface LandingState {
  page: LandingPage | null
  loading: boolean
  saving: boolean
  error: string | null

  load: () => Promise<void>
  updateMeta: (input: UpdateMetaInput) => Promise<void>
  addSection: (input: AddSectionInput) => Promise<void>
  updateSection: (id: string, input: UpdateSectionInput) => Promise<void>
  removeSection: (id: string) => Promise<void>
  reorder: (order: { id: string; position: number }[]) => Promise<void>
  publish: () => Promise<void>
  unpublish: () => Promise<void>
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const useLandingStore = create<LandingState>((set) => {
  /** Runs a mutation, replacing the page snapshot; surfaces errors to callers. */
  const mutate = async (fn: () => Promise<{ landing: LandingPage }>): Promise<void> => {
    set({ saving: true, error: null })
    try {
      const res = await fn()
      set({ page: res.landing, saving: false })
    } catch (err) {
      set({ error: message(err), saving: false })
      throw err
    }
  }

  return {
    page: null,
    loading: false,
    saving: false,
    error: null,

    load: async () => {
      set({ loading: true, error: null })
      try {
        const res = await apiRequest<{ landing: LandingPage }>('/landing')
        set({ page: res.landing, loading: false })
      } catch (err) {
        set({ error: message(err), loading: false })
      }
    },

    updateMeta: (input) =>
      mutate(() => apiRequest<{ landing: LandingPage }>('/landing', { method: 'PUT', body: input })),

    addSection: (input) =>
      mutate(() =>
        apiRequest<{ landing: LandingPage }>('/landing/sections', { method: 'POST', body: input })
      ),

    updateSection: (id, input) =>
      mutate(() =>
        apiRequest<{ landing: LandingPage }>(`/landing/sections/${id}`, {
          method: 'PUT',
          body: input,
        })
      ),

    removeSection: (id) =>
      mutate(() =>
        apiRequest<{ landing: LandingPage }>(`/landing/sections/${id}`, { method: 'DELETE' })
      ),

    reorder: (order) =>
      mutate(() =>
        apiRequest<{ landing: LandingPage }>('/landing/sections/order', {
          method: 'PUT',
          body: { order },
        })
      ),

    publish: () =>
      mutate(() => apiRequest<{ landing: LandingPage }>('/landing/publish', { method: 'POST' })),

    unpublish: () =>
      mutate(() => apiRequest<{ landing: LandingPage }>('/landing/unpublish', { method: 'POST' })),
  }
})
