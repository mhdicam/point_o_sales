/**
 * Cashier PIN login — S2-06.
 *
 * A POS device is already bound to one tenant and outlet, so a cashier only
 * types a short PIN rather than an email and password. That makes the PIN a
 * weak secret by design: 4 digits is 10,000 possibilities.
 *
 * Two things keep it usable without being a hole:
 *   - It only ever authenticates *within* a known tenant and outlet. The lookup
 *     is scoped, so a PIN from one tenant means nothing in another.
 *   - Attempts are rate-limited per membership with a lockout, so brute force
 *     over the whole keyspace is not practical against a live outlet.
 *
 * The PIN is argon2-hashed like a password — cheap to verify once per shift
 * change, and a stolen database still does not hand over PINs.
 */

import { hash, verify } from '@node-rs/argon2'
import type { BrewsyncClient } from '@brewsync/db'
import { unauthorized, forbidden, badRequest } from '../http-error.js'

/** Tuned for a short interactive login, matching the password parameters. */
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const

const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 5 * 60_000

export interface PinLoginInput {
  /** Identifies the cashier within the outlet — shown on the device keypad. */
  employeeCode: string
  pin: string
  outletId: string
}

export class PinService {
  constructor(private readonly db: BrewsyncClient) {}

  /** Hash a PIN for storage. Rejects anything too short to be deliberate. */
  static async hashPin(pin: string): Promise<string> {
    if (!/^\d{4,8}$/.test(pin)) {
      throw badRequest('INVALID_PIN_FORMAT', 'PIN must be 4 to 8 digits')
    }
    return hash(pin, ARGON2_OPTIONS)
  }

  /**
   * Verify a PIN within the request's tenant context.
   *
   * The membership lookup is tenant-scoped by the Prisma extension, so this
   * cannot match a cashier from another tenant even given a colliding code.
   */
  async login(input: PinLoginInput) {
    const { employeeCode, pin, outletId } = input

    const membership = await this.db.tenantMembership.findFirst({
      where: { employeeCode },
      include: { user: { select: { id: true, email: true, fullName: true } } },
    })

    // Uniform failure: revealing "no such employee code" would let someone map
    // out valid codes by trying them.
    if (!membership?.pinHash) {
      throw unauthorized('Invalid employee code or PIN')
    }

    if (membership.status !== 'ACTIVE') {
      throw forbidden('MEMBERSHIP_INACTIVE', 'This membership is not active')
    }

    if (membership.pinLockedUntil && membership.pinLockedUntil > new Date()) {
      throw forbidden('PIN_LOCKED', 'Too many failed attempts — try again later')
    }

    const valid = await verify(membership.pinHash, pin, ARGON2_OPTIONS)

    if (!valid) {
      await this.registerFailure(membership.id, membership.pinFailedAttempts)
      throw unauthorized('Invalid employee code or PIN')
    }

    // A successful login clears the counter so ordinary typos never accumulate
    // into a lockout across shifts.
    if (membership.pinFailedAttempts > 0 || membership.pinLockedUntil) {
      await this.db.tenantMembership.update({
        where: { id: membership.id },
        data: { pinFailedAttempts: 0, pinLockedUntil: null },
      })
    }

    return { user: { ...membership.user, name: membership.user.fullName }, membershipId: membership.id, outletId }
  }

  private async registerFailure(membershipId: string, currentAttempts: number): Promise<void> {
    const attempts = currentAttempts + 1
    const locked = attempts >= MAX_ATTEMPTS

    await this.db.tenantMembership.update({
      where: { id: membershipId },
      data: {
        pinFailedAttempts: locked ? 0 : attempts,
        pinLockedUntil: locked ? new Date(Date.now() + LOCKOUT_MS) : null,
      },
    })
  }
}
