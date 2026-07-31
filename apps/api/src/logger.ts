/**
 * Structured logging — S0-07.
 *
 * pino, JSON in production and pretty in dev. Every log line carries
 * `requestId` and `tenantId` (CLAUDE.md conventions) so a report of "tenant X
 * saw the wrong total" can be traced without guessing which request it was.
 *
 * Redaction is deny-by-default on the usual credential-carrying paths —
 * accidentally logging a whole request body should not leak a password.
 */

import pino from 'pino'
import type { Config } from './config.js'

export type Logger = pino.Logger

export function createLogger(config: Config): Logger {
  return pino({
    // Request logs would bury the reporter output; a test that needs to assert
    // on a log line can build its own logger.
    level: config.isTest ? 'silent' : config.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        'pin',
        'passwordHash',
        'pinHash',
        'token',
        'accessToken',
        'refreshToken',
        '*.password',
        '*.pin',
        '*.token',
      ],
      censor: '[redacted]',
    },
    // Pretty output is for a human watching a dev terminal. Production wants
    // parseable JSON, and tests want neither a transport worker (it fails to
    // resolve under vitest) nor noise in the reporter output.
    ...(config.isProduction || config.isTest
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }),
  })
}
