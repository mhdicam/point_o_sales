/**
 * Access store — the session's effective permissions and feature toggles.
 *
 * Loaded once after a scope is selected, from the two /me endpoints:
 *   GET /me/permissions → string[] of granted permission keys
 *   GET /me/features    → FeatureFlags for the scoped tenant
 *
 * Consumed by usePermission / useFeature, which are UX-only (standard #5): they
 * decide what to *show*, never what is *allowed*. The backend re-checks every
 * mutation with requirePermission / requireFeature, so a tampered store can hide
 * or reveal buttons but cannot widen actual access.
 */

import { create } from 'zustand'
import { apiRequest } from '../lib/api-client.ts'
import type { FeatureFlags, FeatureKey, PermissionKey } from '@brewsync/shared'

interface AccessState {
  permissions: Set<PermissionKey>
  features: Partial<FeatureFlags>
  loaded: boolean

  /** Fetch permissions + features for the current scope. Idempotent-ish: always refetches. */
  load: () => Promise<void>
  reset: () => void

  can: (permission: PermissionKey) => boolean
  feature: (key: FeatureKey) => boolean
}

export const useAccessStore = create<AccessState>((set, get) => ({
  permissions: new Set(),
  features: {},
  loaded: false,

  load: async () => {
    const [perm, feat] = await Promise.all([
      apiRequest<{ permissions: PermissionKey[] }>('/me/permissions'),
      apiRequest<{ features: Partial<FeatureFlags> }>('/me/features'),
    ])
    set({
      permissions: new Set(perm.permissions),
      features: feat.features,
      loaded: true,
    })
  },

  reset: () => set({ permissions: new Set(), features: {}, loaded: false }),

  can: (permission) => get().permissions.has(permission),
  feature: (key) => get().features[key] === true,
}))
