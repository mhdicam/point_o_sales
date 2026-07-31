/**
 * S2-04 integration test — permission guards reject unauthorized users.
 *
 * Acceptance criterion (sprint plan §2): "Endpoint sensitif nolak user tanpa
 * permission." This test proves that the requirePermission middleware actually
 * enforces the guard, not just that the route is wired.
 *
 * Setup: two users in the same tenant, one with product.view, one without.
 * Both users can authenticate and reach tenant-scoped routes; only the first
 * can reach /example/products.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createPrismaClient, runUnscoped } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { createApp } from '../src/app.js'
import { TokenService } from '../src/services/token.service.js'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

const APP_ROLE_URL = process.env.TEST_DATABASE_URL!
const OWNER_ROLE_URL = process.env.TEST_DIRECT_DATABASE_URL!

describe('S2-04 — permission guards', () => {
  const dbApp = createPrismaClient({ datasourceUrl: APP_ROLE_URL })
  const dbOwner = createPrismaClient({ datasourceUrl: OWNER_ROLE_URL })
  const config = loadConfig()
  const logger = createLogger(config)
  const app = createApp(dbApp, config, logger)

  // Fixtures are namespaced per run. `User` is a global model with a unique
  // email and is not reachable by the tenant cascade, so a suite that reused a
  // fixed address would 409 against its own leftovers after any failed run.
  const runId = randomUUID().slice(0, 8)
  const allowedEmail = `allowed-${runId}@test.local`
  const deniedEmail = `denied-${runId}@test.local`

  let tenantId: string
  let outletId: string
  let userWithPermission: { id: string; email: string; accessToken: string }
  let userWithoutPermission: { id: string; email: string; accessToken: string }

  beforeAll(async () => {
    // Register two users first (global, no tenant context needed).
    const res1 = await request(app).post('/auth/register').send({
      email: allowedEmail,
      password: 'password123',
      name: 'Allowed User',
    })
    expect(res1.status).toBe(201)
    userWithPermission = {
      id: res1.body.user.id,
      email: res1.body.user.email,
      accessToken: res1.body.accessToken,
    }

    const res2 = await request(app).post('/auth/register').send({
      email: deniedEmail,
      password: 'password123',
      name: 'Denied User',
    })
    expect(res2.status).toBe(201)
    userWithoutPermission = {
      id: res2.body.user.id,
      email: res2.body.user.email,
      accessToken: res2.body.accessToken,
    }

    // Build tenant fixtures as the owner so RLS WITH CHECK is satisfied.
    const tenantRow = await runUnscoped(() =>
      dbOwner.$queryRaw<Array<{ id: string }>>`
        INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
        VALUES (gen_random_uuid(), ${`guard-test-${runId}`}, 'Guard Test Tenant', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
        RETURNING id
      `
    )
    tenantId = tenantRow[0]!.id

    // Set the GUC so the outlet insert passes RLS.
    await dbOwner.$executeRawUnsafe(
      `SELECT set_config('app.current_tenant', $1, false)`,
      tenantId
    )

    const outletRow = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO outlets (id, "tenantId", code, name, status, "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'MAIN', 'Main Outlet', 'ACTIVE', now())
      RETURNING id
    `
    outletId = outletRow[0]!.id

    // Create a role with product.view, assign it to the first user.
    const roleRow = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO roles (id, "tenantId", name, "isSystem", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'Product Viewer', false, now())
      RETURNING id
    `
    const roleId = roleRow[0]!.id

    // Seed the permission catalog if it doesn't exist (global, no GUC).
    await runUnscoped(() =>
      dbOwner.$executeRaw`
        INSERT INTO permissions (key, domain, description)
        VALUES (${PERMISSIONS.PRODUCT_VIEW}, 'product', 'View products')
        ON CONFLICT (key) DO NOTHING
      `
    )

    await dbOwner.$executeRaw`
      INSERT INTO role_permissions ("roleId", "permissionKey")
      VALUES (${roleId}::uuid, ${PERMISSIONS.PRODUCT_VIEW})
    `

    // Create memberships for both users, assign the role to the first.
    await dbOwner.$executeRaw`
      INSERT INTO tenant_memberships (id, "tenantId", "userId", status, "updatedAt")
      VALUES
        (gen_random_uuid(), ${tenantId}::uuid, ${userWithPermission.id}::uuid, 'ACTIVE', now()),
        (gen_random_uuid(), ${tenantId}::uuid, ${userWithoutPermission.id}::uuid, 'ACTIVE', now())
    `

    await dbOwner.$executeRaw`
      INSERT INTO user_roles (id, "tenantId", "userId", "roleId")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${userWithPermission.id}::uuid, ${roleId}::uuid)
    `

    // Mint tokens through the real TokenService rather than hand-signing, so
    // the claim shape under test is the one the app actually issues. Register
    // returned tokens already, but those carry no tenant/outlet context —
    // that context is only chosen after login.
    const tokenService = new TokenService(config, dbOwner)
    userWithPermission.accessToken = (
      await runUnscoped(() =>
        tokenService.issue({ sub: userWithPermission.id, tenantId, outletId })
      )
    ).accessToken
    userWithoutPermission.accessToken = (
      await runUnscoped(() =>
        tokenService.issue({ sub: userWithoutPermission.id, tenantId, outletId })
      )
    ).accessToken
  })

  afterAll(async () => {
    // Deleting the tenant cascades to outlets, memberships, roles and role
    // assignments. Users are global, so they need deleting on their own — their
    // refresh tokens cascade from there.
    await runUnscoped(async () => {
      await dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`
      await dbOwner.$executeRaw`
        DELETE FROM users WHERE email IN (${allowedEmail}, ${deniedEmail})
      `
    })
    await dbApp.$disconnect()
    await dbOwner.$disconnect()
  })

  it('allows a user with the required permission', async () => {
    const res = await request(app)
      .get('/example/products')
      .set('Authorization', `Bearer ${userWithPermission.accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.message).toContain('guarded by product.view')
  })

  it('rejects a user without the required permission with 403', async () => {
    const res = await request(app)
      .get('/example/products')
      .set('Authorization', `Bearer ${userWithoutPermission.accessToken}`)

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS')
    expect(res.body.error.details.required).toContain(PERMISSIONS.PRODUCT_VIEW)
    expect(res.body.error.details.missing).toContain(PERMISSIONS.PRODUCT_VIEW)
  })

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/example/products')

    expect(res.status).toBe(401)
  })
})
