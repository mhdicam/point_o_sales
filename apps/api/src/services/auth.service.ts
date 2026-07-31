/**
 * Auth service — S1-05 register/login.
 *
 * User is a global identity: one login works across every tenant. Per-tenant
 * data lives on TenantMembership, which also carries the cashier pinHash for
 * fast device login (S2-06).
 */

import { hash, verify } from '@node-rs/argon2'
import type { BrewsyncClient } from '@brewsync/db'
import { runUnscoped } from '@brewsync/db'
import { unauthorized, conflict, badRequest } from '../http-error.js'

export interface RegisterInput {
  email: string
  password: string
  name: string
}

export interface LoginInput {
  email: string
  password: string
}

export class AuthService {
  constructor(private readonly db: BrewsyncClient) {}

  async register(input: RegisterInput) {
    const { email, password, name } = input

    if (password.length < 8) {
      throw badRequest('WEAK_PASSWORD', 'Password must be at least 8 characters')
    }

    // User has no tenantId — it is cross-tenant, so the query runs unscoped.
    const existing = await runUnscoped(() => this.db.user.findUnique({ where: { email } }))

    if (existing) {
      throw conflict('EMAIL_TAKEN', 'Email already registered')
    }

    const passwordHash = await hash(password, {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    })

    const user = await runUnscoped(() =>
      this.db.user.create({
        data: { email, passwordHash, fullName: name },
        select: { id: true, email: true, fullName: true, createdAt: true },
      })
    )

    return { ...user, name: user.fullName }
  }

  async login(input: LoginInput) {
    const { email, password } = input

    const user = await runUnscoped(() =>
      this.db.user.findUnique({
        where: { email },
        select: { id: true, email: true, fullName: true, passwordHash: true },
      })
    )

    if (!user) {
      throw unauthorized()
    }

    const valid = await verify(user.passwordHash ?? '', password, {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    })

    if (!valid) {
      throw unauthorized()
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...userWithoutHash } = user
    return { ...userWithoutHash, name: user.fullName }
  }
}
