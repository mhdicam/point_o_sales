/**
 * apps/api — Express server entry point.
 *
 * Boots the app, binds a port, and starts the outbox worker.
 */

import { createPrismaClient } from '@brewsync/db'
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createApp } from './app.js'
import { startOutboxWorker } from './services/outbox.service.js'

const config = loadConfig()
const logger = createLogger(config)
const db = createPrismaClient({
  datasourceUrl: config.DATABASE_URL,
  log: config.isProduction ? [] : ['error', 'warn'],
})

const app = createApp(db, config, logger)

const port = config.PORT

const server = app.listen(port, () => {
  logger.info({ port }, `API server listening`)
})

// S1-06 — outbox worker (cross-tenant background poller).
const outboxWorker = startOutboxWorker(db, logger, config)

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully')
  outboxWorker.stop()
  server.close(() => {
    logger.info('HTTP server closed')
    process.exit(0)
  })
})
