/**
 * KDS WebSocket client — S7-07, pairs with the hub in apps/api/src/realtime/kds.hub.ts.
 *
 * Opens `wss://host/ws/kds?outletId=…&token=…` and calls back on every frame. The
 * access token rides in the query because a browser cannot set an Authorization
 * header on a WebSocket handshake (the hub verifies it exactly as the REST
 * middleware verifies the header). The token is read fresh from the auth store on
 * each (re)connect, so a rotation between reconnect attempts uses the new token.
 *
 * Resilience: a dropped socket reconnects with capped exponential backoff until
 * `close()` is called. The store treats a frame as a "re-read the board" signal,
 * so a brief gap only delays an update — it never corrupts state.
 */

import { useAuthStore } from '../stores/auth.store.ts'

/** Where the API lives — same resolution as api-client.ts. */
const API_BASE = import.meta.env.VITE_API_URL ?? '/api'
const KDS_PATH = '/ws/kds'

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 15_000

export interface KdsFrame {
  type: string
  payload: unknown
}

export interface KdsSocketCallbacks {
  onFrame: (frame: KdsFrame) => void
  onOpen?: () => void
  onClose?: () => void
}

export interface KdsSocketHandle {
  close: () => void
}

/**
 * Resolve the WebSocket origin. API_BASE is a same-origin path (`/api`) in dev or
 * an absolute http(s) URL in prod; either way the WS lives at the server root's
 * `/ws/kds`, on the ws/wss scheme matching the page.
 */
function wsBase(): string {
  // Absolute API URL → swap http(s) for ws(s), drop any path.
  if (/^https?:\/\//i.test(API_BASE)) {
    const url = new URL(API_BASE)
    const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${scheme}//${url.host}`
  }
  // Same-origin dev: derive from the page location.
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}`
}

export function openKdsSocket(
  outletId: string,
  callbacks: KdsSocketCallbacks
): KdsSocketHandle {
  let ws: WebSocket | null = null
  let closed = false
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const connect = (): void => {
    if (closed) return
    const token = useAuthStore.getState().accessToken
    if (!token) {
      // No token yet — retry shortly rather than opening an unauthenticated socket.
      scheduleReconnect()
      return
    }

    const params = new URLSearchParams({ outletId, token })
    ws = new WebSocket(`${wsBase()}${KDS_PATH}?${params.toString()}`)

    ws.onopen = () => {
      attempt = 0
      callbacks.onOpen?.()
    }

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as KdsFrame
        callbacks.onFrame(frame)
      } catch {
        // Ignore a malformed frame — the next board read reconciles anyway.
      }
    }

    ws.onclose = () => {
      callbacks.onClose?.()
      if (!closed) scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose fires after onerror; reconnection is handled there.
      ws?.close()
    }
  }

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS)
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  connect()

  return {
    close: () => {
      closed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (ws) {
        ws.onclose = null
        ws.onerror = null
        ws.close()
        ws = null
      }
    },
  }
}
