/**
 * apps/api — Express server entry point.
 *
 * Boots the app, binds a port, and starts the outbox worker.
 */

import { createPrismaClient } from '@brewsync/db'
import { EVENT_TYPES } from '@brewsync/shared'
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createApp } from './app.js'
import { createSystemClient } from './system-client.js'
import { startOutboxWorker } from './services/outbox.service.js'
import { KdsHub } from './realtime/kds.hub.js'

const config = loadConfig()
const logger = createLogger(config)
const db = createPrismaClient({
  datasourceUrl: config.DATABASE_URL,
  log: config.isProduction ? [] : ['error', 'warn'],
})
// The one BYPASSRLS client: powers the pre-tenant / cross-tenant reads (public
// landing + QR resolve, outbox sweep, login membership list). Everything else
// stays on the RLS-subject `db`.
const system = createSystemClient(config)

const app = createApp(db, config, logger, system)

const port = config.PORT

const server = app.listen(port, () => {
  logger.info({ port }, `API server listening`)
})

// S7-05 — KDS realtime hub. Shares the HTTP server (one port for REST + WS) and
// is fed from the outbox, so a board only ever sees committed changes.
const kdsHub = new KdsHub(config, logger)
kdsHub.attach(server)

// Events the kitchen board cares about: a new routed ticket, or a lane advance.
const KDS_EVENTS = new Set<string>([EVENT_TYPES.ORDER_SENT, EVENT_TYPES.KDS_ITEM_UPDATED])

// S1-06 — outbox worker (cross-tenant background poller). Fans KDS events to the
// hub as they dispatch (S7-05).
const outboxWorker = startOutboxWorker(db, system, logger, config, (event) => {
  if (KDS_EVENTS.has(event.type)) {
    kdsHub.broadcast(event.outletId, { type: event.type, payload: event.payload })
  }
})

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully')
  outboxWorker.stop()
  kdsHub.close()
  server.close(() => {
    logger.info('HTTP server closed')
    process.exit(0)
  })
})
