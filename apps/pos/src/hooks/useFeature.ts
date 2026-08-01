/**
 * useFeature — S2-07. UX only.
 *
 * Returns whether a feature toggle is on for the scoped tenant/outlet, for
 * hiding controls that a disabled feature would make meaningless (e.g. the
 * modifiers editor when `modifiers` is off). Not a security check: the backend
 * guards feature-gated routes with requireFeature (standard #5).
 */

import { useAccessStore } from '../stores/access.store.ts'
import type { FeatureKey } from '@brewsync/shared'

export function useFeature(key: FeatureKey): boolean {
  return useAccessStore((s) => s.features[key] === true)
}
