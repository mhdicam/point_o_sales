/**
 * Auth + session store — the FE mirror of the real backend flow:
 *
 *   POST /auth/login          → { user, accessToken, refreshToken }   (no tenant yet)
 *   GET  /session/memberships → tenants + outlets this login can act in
 *   POST /session/select      → { scope, accessToken, refreshToken }  (scoped tokens)
 *
 * A freshly logged-in session holds a *tenant-less* token; it can only reach
 * /session/*. Selecting a scope swaps in a token that carries tenantId/outletId,
 * which is what every master-data route requires.
 *
 * Tokens persist to localStorage so a reload does not force re-login. This is a
 * pragmatic choice for an internal admin tool; the backend remains the security
 * boundary (standard #5) — a stolen token is bounded by its TTL and the refresh
 * rotation, and nothing here is trusted for authorization.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { apiRequest, configureAuthBridge, type AuthBridge } from '../lib/api-client.ts'
import type { AuthUser, Membership, Scope, TokenPair } from '../lib/types.ts'

interface AuthState {
  user: AuthUser | null
  accessToken: string | null
  refreshToken: string | null
  /** Set once a tenant (and optionally outlet) has been chosen. */
  scope: Scope | null

  login: (email: string, password: string) => Promise<void>
  listMemberships: () => Promise<Membership[]>
  selectScope: (tenantId: string, outletId?: string) => Promise<void>
  /** Rotate the refresh token. Returns the new access token, or null on failure. */
  refresh: () => Promise<string | null>
  logout: () => void

  /** True once a scoped token exists — the gate for entering /admin. */
  hasScope: () => boolean
}

interface LoginResponse extends TokenPair {
  user: AuthUser
}

interface SelectResponse extends TokenPair {
  scope: Scope
}

// A single in-flight refresh is shared across concurrent 401s so the refresh
// token rotates once, not once per racing request (rotation invalidates the
// old token — parallel rotations would revoke each other).
let refreshInFlight: Promise<string | null> | null = null

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      scope: null,

      login: async (email, password) => {
        const res = await apiRequest<LoginResponse>('/auth/login', {
          method: 'POST',
          auth: false,
          body: { email, password },
        })
        // A new login clears any previously selected scope.
        set({
          user: res.user,
          accessToken: res.accessToken,
          refreshToken: res.refreshToken,
          scope: null,
        })
      },

      listMemberships: async () => {
        const res = await apiRequest<{ memberships: Membership[] }>('/session/memberships')
        return res.memberships
      },

      selectScope: async (tenantId, outletId) => {
        const res = await apiRequest<SelectResponse>('/session/select', {
          method: 'POST',
          body: { tenantId, ...(outletId ? { outletId } : {}) },
        })
        set({
          accessToken: res.accessToken,
          refreshToken: res.refreshToken,
          scope: res.scope,
        })
      },

      refresh: async () => {
        if (refreshInFlight) return refreshInFlight

        const token = get().refreshToken
        if (!token) return null

        refreshInFlight = (async () => {
          try {
            const res = await apiRequest<TokenPair>('/auth/refresh', {
              method: 'POST',
              auth: false,
              body: { refreshToken: token },
            })
            set({ accessToken: res.accessToken, refreshToken: res.refreshToken })
            return res.accessToken
          } catch {
            // Refresh rejected → the session is dead. Clear it so route guards
            // send the user back to login.
            set({ user: null, accessToken: null, refreshToken: null, scope: null })
            return null
          } finally {
            refreshInFlight = null
          }
        })()

        return refreshInFlight
      },

      logout: () => {
        set({ user: null, accessToken: null, refreshToken: null, scope: null })
      },

      hasScope: () => get().scope !== null && get().accessToken !== null,
    }),
    {
      name: 'brewsync.auth',
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        scope: state.scope,
      }),
    }
  )
)

// Bridge the store into the api-client so requests attach the token and can
// silently rotate on 401. Reads go through getState() to always see the latest.
const bridge: AuthBridge = {
  getAccessToken: () => useAuthStore.getState().accessToken,
  refresh: () => useAuthStore.getState().refresh(),
}
configureAuthBridge(bridge)
