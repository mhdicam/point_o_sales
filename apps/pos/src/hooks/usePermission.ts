/**
 * usePermission — S2-05. UX only.
 *
 * Returns whether the session holds a permission, for hiding/disabling controls.
 * This is NOT an authorization check: the backend guards every mutation with
 * requirePermission (standard #5). Guarding solely here would be a bug.
 */

import { useAccessStore } from '../stores/access.store.ts'
import type { PermissionKey } from '@brewsync/shared'

export function usePermission(permission: PermissionKey): boolean {
  return useAccessStore((s) => s.permissions.has(permission))
}
