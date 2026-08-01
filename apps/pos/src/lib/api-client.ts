/**
 * API client — a thin fetch wrapper, deliberately not TanStack Query (the app's
 * server state lives in Zustand stores instead).
 *
 * Two invariants it exists to hold:
 *
 * 1. Money and unit factors cross the wire as decimal *strings*, never numbers.
 *    The API sets a BigInt json replacer (apps/api/src/app.ts) so `basePrice`,
 *    `priceDelta`, `factor` etc. arrive as strings; this client never coerces a
 *    response body through anything that would turn them into floats. Callers
 *    parse with `money()` from @brewsync/shared at the point of use.
 *
 * 2. The error envelope is uniform. The API always answers failures as
 *    `{ error: { code, message, details? } }` (see errorHandler in
 *    auth.routes.ts). This unwraps that into a typed ApiError so screens branch
 *    on `err.code`, not on HTTP status text.
 *
 * A single silent refresh-and-retry on 401 is built in: an access token expiring
 * mid-session should not surface to the user, but a *second* 401 (refresh also
 * dead) must, so the retry runs at most once.
 */

/** Where the API lives. Empty string in dev → same-origin, proxied by Vite. */
const API_BASE = import.meta.env.VITE_API_URL ?? '/api'

export interface ApiErrorShape {
  code: string
  message: string
  details?: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, body: ApiErrorShape) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code
    this.details = body.details
  }
}

/**
 * Hooks the client needs from the auth layer, injected rather than imported to
 * keep this module free of a cycle with the auth store.
 */
export interface AuthBridge {
  /** Current access token, or null when logged out. */
  getAccessToken: () => string | null
  /**
   * Attempt a token rotation. Returns the new access token on success, or null
   * when refresh is impossible (no refresh token, or it was rejected) — in which
   * case the original 401 propagates and the caller logs out.
   */
  refresh: () => Promise<string | null>
}

let bridge: AuthBridge = {
  getAccessToken: () => null,
  refresh: async () => null,
}

/** Wired once at app start (see stores/auth.store.ts). */
export function configureAuthBridge(next: AuthBridge): void {
  bridge = next
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** JSON-serializable body. BigInt is not expected here — send money as string. */
  body?: unknown
  /** Query params; undefined/null entries are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>
  /** Set false to skip the Authorization header (login, refresh). Default true. */
  auth?: boolean
  signal?: AbortSignal
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined
  const text = await res.text()
  if (!text) return undefined
  // The API only ever emits JSON. Guard anyway so a proxy error page becomes a
  // legible ApiError rather than a JSON.parse throw.
  try {
    return JSON.parse(text)
  } catch {
    return { error: { code: 'NON_JSON_RESPONSE', message: text.slice(0, 200) } }
  }
}

function toApiError(status: number, body: unknown): ApiError {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object' &&
    (body as { error: unknown }).error !== null
  ) {
    return new ApiError(status, (body as { error: ApiErrorShape }).error)
  }
  return new ApiError(status, { code: 'UNKNOWN', message: `Request failed (${status})` })
}

async function dispatch(path: string, options: RequestOptions, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.auth !== false && token) headers['Authorization'] = `Bearer ${token}`

  return fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

/**
 * Perform a request and return the parsed JSON body typed as `T`.
 *
 * `T` is a caller assertion: the client cannot validate the shape without a
 * schema per route, and the API is the source of truth. Money fields inside `T`
 * should be typed as `string` to keep the no-float rule visible at the type
 * level.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = bridge.getAccessToken()
  let res = await dispatch(path, options, token)

  // One silent rotation on an expired access token, then retry once.
  if (res.status === 401 && options.auth !== false) {
    const refreshed = await bridge.refresh()
    if (refreshed) {
      res = await dispatch(path, options, refreshed)
    }
  }

  const body = await parseBody(res)
  if (!res.ok) {
    throw toApiError(res.status, body)
  }
  return body as T
}
