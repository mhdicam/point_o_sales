/**
 * Tenant selection — S2-09.
 *
 * The point under test is a mount-point invariant as much as a service one: an
 * email/password login mints a token with no tenant, so these two routes have to
 * be reachable by a token that `requireTenant` would reject. If someone later
 * moves them under createMeRouter (or wraps them in requireTenant), the first
 * two assertions here go red rather than the admin UI silently losing its way in
 * to a tenant.
 *
 * Fixtures are raw inserts rather than POST /onboarding/tenants: onboarding
 * creates its owner as INVITED with a null passwordHash and provisions one
 * tenant per call, and this suite needs an ACTIVE user holding a membership in
 * exactly one of two tenants.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import { createApp } from '../src/app.js'
import { createPrismaClient, createSystemPrismaClient } from '@brewsync/db'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { TokenService } from '../src/services/token.service.js'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

/** Pin the owner client to one connection so a session-level GUC persists. */
function withConnectionLimitOne(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`
}

describe('Session scope selection', () => {
  const config = loadConfig()
  const logger = createLogger(config)
  // Owner is FORCE-RLS-subject; pin it so the fixture set_config below sticks
  // across the raw inserts on RLS tables (outlets, tenant_memberships).
  const dbOwner = createPrismaClient({
    datasourceUrl: withConnectionLimitOne(process.env.TEST_DIRECT_DATABASE_URL ?? ''),
  })
  // The BYPASSRLS system client backs the session service's cross-tenant
  // membership read — the whole point of S2-09 is to read across tenants before
  // one is selected.
  const dbSystem = createSystemPrismaClient({ datasourceUrl: process.env.TEST_UNSCOPED_DATABASE_URL ?? '' })
  const app = createApp(dbOwner, config, logger, dbSystem)
  const request = supertest(app)

  const runId = randomUUID().slice(0, 8)
  const userEmail = `session-test-${runId}@test.local`

  /** The tenant the fixture user is a member of. */
  let memberTenantId: string
  let memberOutletId: string
  /** A second tenant the user has no membership in — the negative case. */
  let strangerTenantId: string
  let strangerOutletId: string
  let userId: string
  /** Token as minted by /auth/login: a subject, and no tenant at all. */
  let tenantlessToken: string

  const bindTenant = async (tenantId: string): Promise<void> => {
    // RLS is FORCEd, so the owner role is subject to it too, and the binding is
    // per-session: it has to be re-issued before each tenant's inserts or the
    // second tenant's rows fail the WITH CHECK clause with 42501. The owner
    // client is pinned to one connection (connection_limit=1), so this session
    // setting persists across the raw inserts below.
    await dbOwner.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, false)`, tenantId)
  }

  const insertTenant = async (slug: string, name: string): Promise<string> => {
    const rows = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
      VALUES (gen_random_uuid(), ${slug}, ${name}, 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
      RETURNING id
    `
    return rows[0]!.id
  }

  const insertOutlet = async (tenantId: string, code: string, name: string): Promise<string> => {
    const rows = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO outlets (id, "tenantId", code, name, status, "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${code}, ${name}, 'ACTIVE', now())
      RETURNING id
    `
    return rows[0]!.id
  }

  beforeAll(async () => {
    memberTenantId = await insertTenant(`session-member-${runId}`, 'Session Member Tenant')
    await bindTenant(memberTenantId)
    memberOutletId = await insertOutlet(memberTenantId, 'MAIN', 'Main Outlet')

    strangerTenantId = await insertTenant(`session-stranger-${runId}`, 'Session Stranger Tenant')
    await bindTenant(strangerTenantId)
    strangerOutletId = await insertOutlet(strangerTenantId, 'MAIN', 'Stranger Outlet')

    const userRows = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO users (id, email, "fullName", status, "passwordHash", "updatedAt")
      VALUES (gen_random_uuid(), ${userEmail}, 'Session Test User', 'ACTIVE', 'unused', now())
      RETURNING id
    `
    userId = userRows[0]!.id

    // Membership in the member tenant only. The stranger tenant exists and is
    // ACTIVE — what makes it inaccessible is the absence of this row, not the
    // tenant's own state.
    await bindTenant(memberTenantId)
    await dbOwner.$executeRaw`
      INSERT INTO tenant_memberships (id, "tenantId", "userId", "displayName", "employeeCode", "updatedAt")
      VALUES (gen_random_uuid(), ${memberTenantId}::uuid, ${userId}::uuid, 'Session Test User', 'EMP-001', now())
    `

    const tokenService = new TokenService(config, dbOwner)
    tenantlessToken = (await tokenService.issue({ sub: userId })).accessToken
  })

  afterAll(async () => {
    await dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${memberTenantId}::uuid`
    await dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${strangerTenantId}::uuid`
    await dbOwner.$executeRaw`DELETE FROM users WHERE email = ${userEmail}`
    await dbOwner.$disconnect()
    await dbSystem.$disconnect()
  })

  it('rejects an anonymous caller', async () => {
    const res = await request.get('/session/memberships')

    expect(res.status).toBe(401)
  })

  it('lists memberships for a token that carries no tenant', async () => {
    const res = await request
      .get('/session/memberships')
      .set('Authorization', `Bearer ${tenantlessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.memberships).toHaveLength(1)

    const membership = res.body.memberships[0]
    expect(membership.tenantId).toBe(memberTenantId)
    expect(membership.tenantSlug).toBe(`session-member-${runId}`)
    expect(membership.employeeCode).toBe('EMP-001')
    // Only the member tenant's outlet — the stranger outlet must not leak in
    // through the per-membership scoped read.
    expect(membership.outlets).toHaveLength(1)
    expect(membership.outlets[0].id).toBe(memberOutletId)
    expect(membership.outlets[0].code).toBe('MAIN')
  })

  it('selects a tenant and issues a scoped token pair', async () => {
    const res = await request
      .post('/session/select')
      .set('Authorization', `Bearer ${tenantlessToken}`)
      .send({ tenantId: memberTenantId, outletId: memberOutletId })

    expect(res.status).toBe(200)
    expect(res.body.scope).toEqual({ tenantId: memberTenantId, outletId: memberOutletId })
    expect(typeof res.body.accessToken).toBe('string')
    expect(typeof res.body.refreshToken).toBe('string')

    // The token is only useful if it opens the routes the tenant-less one could
    // not: /me sits behind requireTenant.
    const scoped = await request
      .get('/me/features')
      .set('Authorization', `Bearer ${res.body.accessToken}`)

    expect(scoped.status).toBe(200)
  })

  it('allows a tenant-wide selection with no outlet', async () => {
    const res = await request
      .post('/session/select')
      .set('Authorization', `Bearer ${tenantlessToken}`)
      .send({ tenantId: memberTenantId })

    expect(res.status).toBe(200)
    expect(res.body.scope.tenantId).toBe(memberTenantId)
    expect(res.body.scope.outletId).toBeUndefined()
  })

  it('refuses a tenant the caller holds no membership in', async () => {
    const res = await request
      .post('/session/select')
      .set('Authorization', `Bearer ${tenantlessToken}`)
      .send({ tenantId: strangerTenantId })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('TENANT_NOT_ACCESSIBLE')
  })

  it('gives an unknown tenant the same answer as an inaccessible one', async () => {
    // Distinguishing the two would turn the endpoint into a tenant-enumeration
    // oracle, so this asserts the indistinguishability on purpose.
    const res = await request
      .post('/session/select')
      .set('Authorization', `Bearer ${tenantlessToken}`)
      .send({ tenantId: randomUUID() })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('TENANT_NOT_ACCESSIBLE')
  })

  it("refuses an outlet belonging to another tenant", async () => {
    const res = await request
      .post('/session/select')
      .set('Authorization', `Bearer ${tenantlessToken}`)
      .send({ tenantId: memberTenantId, outletId: strangerOutletId })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('OUTLET_NOT_ACCESSIBLE')
  })

  it('validates the request body', async () => {
    const res = await request
      .post('/session/select')
      .set('Authorization', `Bearer ${tenantlessToken}`)
      .send({ tenantId: 'not-a-uuid' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('keeps the selected scope across a refresh', async () => {
    const selected = await request
      .post('/session/select')
      .set('Authorization', `Bearer ${tenantlessToken}`)
      .send({ tenantId: memberTenantId, outletId: memberOutletId })

    expect(selected.status).toBe(200)

    const refreshed = await request
      .post('/auth/refresh')
      .send({ refreshToken: selected.body.refreshToken })

    expect(refreshed.status).toBe(200)

    // Behavioural check: the rotated access token still opens a route behind
    // requireTenant. If RefreshToken stopped carrying scopeTenantId, this would
    // come back 403 TENANT_REQUIRED.
    const scoped = await request
      .get('/me/features')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`)

    expect(scoped.status).toBe(200)
  })
})
