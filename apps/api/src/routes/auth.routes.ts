/**
 * Auth routes — S1-05.
 *
 * POST /auth/register — create a global User (no tenant yet).
 * POST /auth/login — verify credentials, issue tokens.
 * POST /auth/refresh — rotate refresh token, issue new access token.
 * POST /auth/logout — revoke the refresh token family.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient } from '@brewsync/db'
import type { Config } from '../config.js'
import { AuthService } from '../services/auth.service.js'
import { TokenService } from '../services/token.service.js'
import { HttpError } from '../http-error.js'

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})

export function createAuthRouter(db: BrewsyncClient, config: Config): Router {
  const router = Router()
  const authService = new AuthService(db)
  const tokenService = new TokenService(config, db)

  router.post('/register', async (req, res, next) => {
    try {
      const input = registerSchema.parse(req.body)
      const user = await authService.register(input)
      const tokens = await tokenService.issue({ sub: user.id })

      res.status(201).json({ user, ...tokens })
    } catch (error) {
      next(error)
    }
  })

  router.post('/login', async (req, res, next) => {
    try {
      const input = loginSchema.parse(req.body)
      const user = await authService.login(input)
      const tokens = await tokenService.issue({ sub: user.id })

      res.json({ user, ...tokens })
    } catch (error) {
      next(error)
    }
  })

  router.post('/refresh', async (req, res, next) => {
    try {
      const { refreshToken } = refreshSchema.parse(req.body)
      const tokens = await tokenService.rotate(refreshToken)

      res.json(tokens)
    } catch (error) {
      next(error)
    }
  })

  router.post('/logout', async (req, res, next) => {
    try {
      const { refreshToken } = refreshSchema.parse(req.body)
      await tokenService.revokeFamily(refreshToken)

      res.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  return router
}

/** Global error handler — converts HttpError + ZodError + Prisma errors. */
export function errorHandler(
  error: unknown,
  _req: unknown,
  res: { status: (code: number) => { json: (body: unknown) => void } },
  _next: unknown
): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    })
    return
  }

  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: error.errors },
    })
    return
  }

  // Prisma P2002 = unique constraint violation.
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  ) {
    res.status(409).json({
      error: { code: 'CONFLICT', message: 'Resource already exists' },
    })
    return
  }

  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  })
}
