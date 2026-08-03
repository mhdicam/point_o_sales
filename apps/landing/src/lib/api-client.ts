/**
 * API client — a thin fetch wrapper for the PUBLIC QR endpoints only.
 *
 * A trimmed sibling of the POS client (apps/pos/src/lib/api-client.ts). The two
 * invariants it keeps are the same:
 *
 * 1. Money crosses the wire as decimal *strings*, never numbers. The API sets a
 *    BigInt json replacer (apps/api/src/app.ts) so prices arrive as strings;
 *    this client never coerces a body through anything that would float them.
 *    Callers parse with `money()` from @brewsync/shared at the point of use.
 *
 * 2. The error envelope is uniform: the API answers failures as
 *    `{ error: { code, message, details? } }`. This unwraps that into a typed
 *    ApiError so screens branch on `err.code` (e.g. QR_INVALID, QR_RATE_LIMITED),
 *    not on HTTP status text.
 *
 * What it deliberately drops vs. the POS client: there is NO auth bridge and no
 * 401 refresh-retry. The QR endpoints are unauthenticated — they key entirely on
 * the path token (design §16.2) — so this client never sends an Authorization
 * header. That absence is the point: the customer app holds no credentials.
 */

/** Where the API lives. Empty/undefined in dev → same-origin, proxied by Vite. */
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

export interface RequestOptions {
  method?: 'GET' | 'POST'
  /** JSON-serializable body. Send money as string, never BigInt/number. */
  body?: unknown
  signal?: AbortSignal
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

/**
 * Perform a public request and return the parsed JSON body typed as `T`.
 *
 * `T` is a caller assertion (the client cannot validate a shape without a schema
 * per route; the API is the source of truth). Money fields inside `T` should be
 * typed as `string` to keep the no-float rule visible at the type level.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const body = await parseBody(res)
  if (!res.ok) {
    throw toApiError(res.status, body)
  }
  return body as T
}
