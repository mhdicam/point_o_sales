/**
 * Env validation — S0-06.
 *
 * Parsed once at boot and exported as a frozen object. A missing or malformed
 * variable crashes the process here rather than surfacing as a confusing runtime
 * failure three layers deep (an unset JWT secret would otherwise mean tokens
 * signed with `undefined`).
 *
 * Secrets are read from the environment only — never committed. See .env.example
 * for the shape.
 */

import { z } from 'zod'

/** Accepts `15m`, `7d`, `3600` — the formats jsonwebtoken understands. */
const duration = z
  .string()
  .regex(/^\d+[smhd]?$/, 'expected a number optionally suffixed with s/m/h/d, e.g. 15m')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),
  // Connection string for the `brewsync_system` (BYPASSRLS) role. Powers the
  // genuine cross-tenant / pre-tenant reads (public landing + QR resolve, outbox
  // sweep, login membership list). Required: a system without it cannot serve
  // those reads, so fail at boot rather than return zero rows in production.
  UNSCOPED_DATABASE_URL: z.string().url(),

  // No defaults: a fallback secret that works in dev silently ships to prod.
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_ACCESS_TTL: duration.default('15m'),
  JWT_REFRESH_TTL: duration.default('7d'),

  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default(''),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),

  // Optional platform token for tenant provisioning. When unset, the onboarding
  // endpoint is not mounted — tenant creation becomes an out-of-band operation.
  PLATFORM_API_TOKEN: z.string().optional(),
})

export type Env = z.infer<typeof schema>

export interface Config extends Env {
  readonly isProduction: boolean
  readonly isTest: boolean
  /** CORS_ORIGINS split into a list; empty means "same-origin only". */
  readonly corsOrigins: readonly string[]
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source)

  if (!parsed.success) {
    // Report every problem at once — fixing env vars one restart at a time is
    // needless friction. Only names and reasons are printed, never values.
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')

    throw new Error(`Invalid environment configuration:\n${issues}`)
  }

  const env = parsed.data

  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    // Distinct secrets keep an access token from being replayed as a refresh
    // token, which would defeat rotation entirely.
    throw new Error(
      'Invalid environment configuration:\n  - JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ'
    )
  }

  return Object.freeze({
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    corsOrigins: Object.freeze(
      env.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    ),
  })
}
