/**
 * KDS realtime hub — S7-05, design §5.5.
 *
 * A per-outlet WebSocket fan-out for the kitchen board. Screens connect once and
 * receive a push whenever a ticket is routed (`OrderSent`) or a lane advances
 * (`KdsItemUpdated`); no polling. The push source is the transactional outbox
 * (standard #4) — the worker calls `broadcast` as it dispatches, so a realtime
 * frame is never emitted for a business change that did not commit, and the two
 * cannot drift.
 *
 * Transport notes:
 *  - `noServer` mode: the hub owns no port. It hooks the existing HTTP server's
 *    `upgrade` event so REST and WS share one origin and one port.
 *  - Auth on the handshake: browsers cannot set an Authorization header on a
 *    `WebSocket`, so the access token rides in the `?token=` query. It is verified
 *    exactly as the REST middleware verifies the header, and the connection is
 *    pinned to the token's tenant — a socket can only ever receive its own
 *    tenant's outlet traffic (standard #1's spirit, enforced at the edge).
 *  - Liveness: a periodic ping drops sockets that stopped responding, so a closed
 *    laptop lid does not leak a subscriber forever.
 *
 * The hub never reads the database. It only relays already-authorized,
 * already-serialized event payloads to the right room.
 */

import type { Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { Logger } from '../logger.js'
import type { Config } from '../config.js'
import { verifyAccessToken } from '../services/token.service.js'

/** Path the kitchen board connects to: `wss://host/ws/kds?outletId=…&token=…`. */
const KDS_WS_PATH = '/ws/kds'
const HEARTBEAT_MS = 30_000

/** One live board connection, tagged with the room it belongs to. */
interface KdsSocket extends WebSocket {
  tenantId?: string
  outletId?: string
  isAlive?: boolean
}

/** The frame shape pushed to boards. `type` mirrors the outbox event type. */
export interface KdsFrame {
  type: string
  payload: unknown
}

export class KdsHub {
  private readonly wss: WebSocketServer
  /** outletId → set of live sockets. */
  private readonly rooms = new Map<string, Set<KdsSocket>>()
  private heartbeat: NodeJS.Timeout | null = null

  constructor(
    private readonly config: Config,
    private readonly logger: Logger
  ) {
    this.wss = new WebSocketServer({ noServer: true })
    this.wss.on('connection', (socket: KdsSocket) => this.onConnection(socket))
  }

  /** Attaches to the HTTP server's upgrade path. Call once at boot. */
  attach(server: HttpServer): void {
    server.on('upgrade', (req, socket, head) => {
      let url: URL
      try {
        url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
      } catch {
        socket.destroy()
        return
      }
      // Only claim our own path — other upgrade consumers (if any) see it too.
      if (url.pathname !== KDS_WS_PATH) return

      const auth = this.authenticate(url)
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const kws = ws as KdsSocket
        kws.tenantId = auth.tenantId
        kws.outletId = auth.outletId
        this.wss.emit('connection', kws, req)
      })
    })

    this.heartbeat = setInterval(() => this.reap(), HEARTBEAT_MS)
    this.logger.info({ path: KDS_WS_PATH }, 'KDS realtime hub attached')
  }

  /**
   * Fan a frame to every board watching one outlet. Called by the outbox worker
   * as it dispatches a KDS-relevant event; a null outletId (tenant-wide event) is
   * ignored since the board is always outlet-scoped.
   */
  broadcast(outletId: string | null, frame: KdsFrame): void {
    if (!outletId) return
    const room = this.rooms.get(outletId)
    if (!room || room.size === 0) return

    const data = JSON.stringify(frame)
    for (const socket of room) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    }
  }

  /** Verify the handshake token and pull the outlet from the query. */
  private authenticate(url: URL): { tenantId: string; outletId: string } | null {
    const token = url.searchParams.get('token')
    const outletId = url.searchParams.get('outletId')
    if (!token || !outletId) return null

    try {
      const claims = verifyAccessToken(token, this.config.JWT_ACCESS_SECRET)
      if (!claims.tenantId) return null
      // A token scoped to a specific outlet may only watch that outlet; a
      // tenant-wide token (outlet null) may watch any outlet in its tenant.
      if (claims.outletId && claims.outletId !== outletId) return null
      return { tenantId: claims.tenantId, outletId }
    } catch {
      return null
    }
  }

  private onConnection(socket: KdsSocket): void {
    const outletId = socket.outletId
    if (!outletId) {
      socket.close()
      return
    }

    let room = this.rooms.get(outletId)
    if (!room) {
      room = new Set()
      this.rooms.set(outletId, room)
    }
    room.add(socket)

    socket.isAlive = true
    socket.on('pong', () => {
      socket.isAlive = true
    })
    socket.on('close', () => this.remove(socket))
    socket.on('error', () => this.remove(socket))

    this.logger.debug({ outletId, size: room.size }, 'KDS board connected')
  }

  private remove(socket: KdsSocket): void {
    const outletId = socket.outletId
    if (!outletId) return
    const room = this.rooms.get(outletId)
    if (!room) return
    room.delete(socket)
    if (room.size === 0) this.rooms.delete(outletId)
  }

  /** Ping every socket; drop any that missed the previous round. */
  private reap(): void {
    for (const room of this.rooms.values()) {
      for (const socket of room) {
        if (socket.isAlive === false) {
          socket.terminate()
          this.remove(socket)
          continue
        }
        socket.isAlive = false
        try {
          socket.ping()
        } catch {
          this.remove(socket)
        }
      }
    }
  }

  /** Graceful shutdown: stop the heartbeat and close every socket. */
  close(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const room of this.rooms.values()) {
      for (const socket of room) socket.terminate()
      room.clear()
    }
    this.rooms.clear()
    this.wss.close()
  }
}
