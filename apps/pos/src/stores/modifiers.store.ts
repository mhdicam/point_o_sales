/**
 * Modifiers store — modifier groups and their options (S3-04). Feature-gated:
 * the routes sit behind features.modifiers, so screens hide behind useFeature
 * ('modifiers') too (standard #5 — UX side of the guard).
 *
 * priceDelta is signed minor units as a string ("-1000" for "no ice").
 */

import { create } from 'zustand'
import { apiRequest, ApiError } from '../lib/api-client.ts'
import type { ModifierGroup, ModifierOption } from '../lib/types.ts'

export interface GroupInput {
  name: string
  minSelect?: number
  maxSelect?: number | null
  isRequired?: boolean
  sortOrder?: number
  isActive?: boolean
}

export interface OptionInput {
  name: string
  /** Signed minor units, string. */
  priceDelta?: string
  isDefault?: boolean
  sortOrder?: number
  isActive?: boolean
}

interface ModifiersState {
  groups: ModifierGroup[]
  loading: boolean
  error: string | null

  list: (opts?: { includeInactive?: boolean }) => Promise<void>
  createGroup: (input: GroupInput) => Promise<ModifierGroup>
  updateGroup: (id: string, input: Partial<GroupInput>) => Promise<ModifierGroup>
  removeGroup: (id: string) => Promise<void>
  addOption: (groupId: string, input: OptionInput) => Promise<ModifierOption>
  updateOption: (optionId: string, input: Partial<OptionInput>) => Promise<ModifierOption>
  removeOption: (optionId: string) => Promise<void>
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong'
}

export const useModifiersStore = create<ModifiersState>((set, get) => ({
  groups: [],
  loading: false,
  error: null,

  list: async (opts = {}) => {
    set({ loading: true, error: null })
    try {
      const res = await apiRequest<{ groups: ModifierGroup[] }>('/modifiers/groups', {
        query: { includeInactive: opts.includeInactive ?? null },
      })
      set({ groups: res.groups, loading: false })
    } catch (err) {
      set({ error: message(err), loading: false })
    }
  },

  createGroup: async (input) => {
    const res = await apiRequest<{ group: ModifierGroup }>('/modifiers/groups', {
      method: 'POST',
      body: input,
    })
    await get().list({ includeInactive: true })
    return res.group
  },

  updateGroup: async (id, input) => {
    const res = await apiRequest<{ group: ModifierGroup }>(`/modifiers/groups/${id}`, {
      method: 'PUT',
      body: input,
    })
    await get().list({ includeInactive: true })
    return res.group
  },

  removeGroup: async (id) => {
    await apiRequest<{ deleted: boolean }>(`/modifiers/groups/${id}`, { method: 'DELETE' })
    await get().list({ includeInactive: true })
  },

  addOption: async (groupId, input) => {
    const res = await apiRequest<{ modifier: ModifierOption }>(
      `/modifiers/groups/${groupId}/modifiers`,
      { method: 'POST', body: input }
    )
    await get().list({ includeInactive: true })
    return res.modifier
  },

  updateOption: async (optionId, input) => {
    const res = await apiRequest<{ modifier: ModifierOption }>(`/modifiers/${optionId}`, {
      method: 'PUT',
      body: input,
    })
    await get().list({ includeInactive: true })
    return res.modifier
  },

  removeOption: async (optionId) => {
    await apiRequest<{ deleted: boolean }>(`/modifiers/${optionId}`, { method: 'DELETE' })
    await get().list({ includeInactive: true })
  },
}))
