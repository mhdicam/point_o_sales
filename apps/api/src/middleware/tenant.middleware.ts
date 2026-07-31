/**
 * Tenant context middleware — S1-02.
 *
 * Extracts `tenantId` and optional `outletId` from the JWT access token and
 * binds them via AsyncLocalStorage so the Prisma extension can scope queries
 * without every service threading parameters through its signature.
 *
 * The token is issued by /auth/login, optionally enriched later by a
 * tenant-selection endpoint (not yet built — that's post-MVP when a user
 * belongs to multiple tenants).
 *
 * For routes that genuinely operate cross-tenant (login itself, platform admin),
 * skip this middleware or call `runUnscoped`.
 */

import type { Request, Response, NextFunction } from 'express'
import { runWithTenantContext, getTenantContext } from '@brewsync/db'
import { unauthorized, forbidden } from '../http-error.js'
import { verifyAccessToken } from '../services/token.service.js'
import type { Config } from '../config.js'

export function createTenantMiddleware(config: Config) {

  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization

    if (!header?.startsWith('Bearer ')) {
      return next(unauthorized('Missing or malformed authorization header'))
    }

    const token = header.slice(7)

    try {
      const claims = verifyAccessToken(token, config.JWT_ACCESS_SECRET)

      // Tenant context is not always present: a freshly-registered user has
      // none until they create or join a tenant. Routes that need one should
      // check and reject with 403 TENANT_REQUIRED rather than crashing.
      runWithTenantContext(
        {
          tenantId: claims.tenantId ?? '',
          outletId: claims.outletId,
          userId: claims.sub,
          requestId: (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
        },
        () => {
          // The handler runs inside the context scope, so queries see it.
          next()
        }
      )
    } catch (error) {
      next(error)
    }
  }
}

/** Guard: reject when tenant context is empty. Post-login, pre-tenant routes need this. */
export function requireTenant(_req: Request, _res: Response, next: NextFunction) {
  const context = getTenantContext()

  if (!context?.tenantId) {
    return next(forbidden('TENANT_REQUIRED', 'This operation requires an active tenant context'))
  }

  next()
}
