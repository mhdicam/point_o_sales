/**
 * JWT issue/verify + refresh rotation — S1-05.
 *
 * Two token types with separate secrets:
 *   - access: short-lived, carries tenant + outlet context, never stored.
 *   - refresh: long-lived, stored *hashed* so a database leak does not hand out
 *     live sessions, and rotated on every use.
 *
 * Rotation with reuse detection: each refresh consumes its row and issues a new
 * one. Presenting an already-consumed token means it was copied, so the whole
 * family is revoked rather than just rejecting that one call.
 */

import { createHash, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { BrewsyncClient } from '@brewsync/db'
import type { Config } from '../config.js'
import { unauthorized } from '../http-error.js'

export interface AccessTokenClaims {
  sub: string
  tenantId?: string | undefined
  outletId?: string | undefined
}

export interface IssuedTokens {
  accessToken: string
  refreshToken: string
  expiresIn: string
}

/**
 * Refresh tokens are opaque random strings, not JWTs: they must be revocable,
 * and a self-contained token cannot be revoked without a lookup anyway.
 */
const newOpaqueToken = () => randomBytes(48).toString('base64url')

/**
 * SHA-256, not argon2, and deliberately so: this is a 384-bit random value, not
 * a human-chosen password. There is no dictionary to attack, so a slow KDF buys
 * nothing while making every refresh call slower.
 */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * Verify an access token and extract its claims.
 *
 * Exported as a standalone function so the tenant middleware can verify tokens
 * without needing a full TokenService (which requires a database for rotation).
 */
export function verifyAccessToken(token: string, secret: string): AccessTokenClaims {
  try {
    const payload = jwt.verify(token, secret, {
      issuer: 'brewsync',
    })

    if (typeof payload === 'string' || !payload.sub) {
      throw unauthorized('Malformed token')
    }

    return {
      sub: payload.sub,
      tenantId: typeof payload['tenantId'] === 'string' ? payload['tenantId'] : undefined,
      outletId: typeof payload['outletId'] === 'string' ? payload['outletId'] : undefined,
    }
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw unauthorized('Token expired')
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw unauthorized('Invalid token')
    }
    throw error
  }
}

export class TokenService {
  constructor(
    private readonly config: Config,
    private readonly db: BrewsyncClient
  ) {}

  signAccessToken(claims: AccessTokenClaims): string {
    return jwt.sign(claims, this.config.JWT_ACCESS_SECRET, {
      expiresIn: this.config.JWT_ACCESS_TTL,
      issuer: 'brewsync',
    } as jwt.SignOptions)
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    return verifyAccessToken(token, this.config.JWT_ACCESS_SECRET)
  }

  /** Issue a fresh pair and persist the refresh token's hash. */
  async issue(claims: AccessTokenClaims, familyId?: string): Promise<IssuedTokens> {
    const refreshToken = newOpaqueToken()

    await this.db.refreshToken.create({
      data: {
        userId: claims.sub,
        tokenHash: hashToken(refreshToken),
        familyId: familyId ?? randomBytes(16).toString('hex'),
        expiresAt: new Date(Date.now() + parseDuration(this.config.JWT_REFRESH_TTL)),
      },
    })

    return {
      accessToken: this.signAccessToken(claims),
      refreshToken,
      expiresIn: this.config.JWT_ACCESS_TTL,
    }
  }

  /**
   * Rotate a refresh token.
   *
   * The stored row is looked up by hash, so a leaked database still cannot be
   * replayed against this endpoint without the original token.
   */
  async rotate(presented: string): Promise<IssuedTokens> {
    const tokenHash = hashToken(presented)
    const existing = await this.db.refreshToken.findUnique({ where: { tokenHash } })

    if (!existing) {
      throw unauthorized('Invalid refresh token')
    }

    if (existing.revokedAt) {
      // Reuse of a consumed token: the value is out in the open, so every
      // sibling token is suspect. Kill the family, forcing a real login.
      await this.db.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      throw unauthorized('Refresh token reused — session revoked')
    }

    if (existing.expiresAt <= new Date()) {
      throw unauthorized('Refresh token expired')
    }

    await this.db.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    })

    return this.issue(
      {
        sub: existing.userId,
        // RefreshToken doesn't carry tenant/outlet context — those come from
        // tenant selection after login, not from the token itself.
      },
      existing.familyId
    )
  }

  /** Logout — revoke the presented token's whole family. */
  async revokeFamily(presented: string): Promise<void> {
    const existing = await this.db.refreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
    })

    if (!existing) return

    await this.db.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** `7d` → ms. Validated by the config schema, so the shape is already known. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(value)
  if (!match) throw new Error(`Unparseable duration: ${value}`)
  const amount = Number(match[1])
  const unit = match[2]
  return unit ? amount * UNITS[unit]! : amount * 1000
}
