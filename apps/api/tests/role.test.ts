/**
 * Role CRUD integration test — S2-02.
 *
 * Validates custom role creation, updates, listing, and the system-role
 * immutability guard that prevents accidental modification of preset roles.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import { createApp } from '../src/app.js'
import { createPrismaClient, createSystemPrismaClient, seedPermissionCatalog } from '@brewsync/db'
import { PrismaClient } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { TokenService } from '../src/services/token.service.js'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

/** Pin the owner client to one connection so a session-level GUC persists. */
function withConnectionLimitOne(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`
}

describe('Role CRUD', () => {
  const config = loadConfig()
  const logger = createLogger(config)
  // Pinned so the set_config below binds the session the raw RLS-table inserts
  // run on (owner is FORCE-RLS-subject; an unbound connection returns 42501).
  const dbOwner = createPrismaClient({
    datasourceUrl: withConnectionLimitOne(process.env.TEST_DIRECT_DATABASE_URL ?? ''),
  })
  const dbSystem = createSystemPrismaClient({ datasourceUrl: process.env.TEST_UNSCOPED_DATABASE_URL ?? '' })
  const app = createApp(dbOwner, config, logger, dbSystem)
  const request = supertest(app)

  const runId = randomUUID().slice(0, 8)
  const userEmail = `role-test-${runId}@test.local`

  let tenantId: string
  let outletId: string
  let userId: string
  let accessToken: string
  let systemRoleId: string

  beforeAll(async () => {
    const plainClient = new PrismaClient({
      datasourceUrl: process.env.TEST_DIRECT_DATABASE_URL,
    })
    await seedPermissionCatalog(plainClient)
    await plainClient.$disconnect()

    // Create tenant with one preset role to test immutability.
    const tenantRow = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO tenants (id, slug, name, status, timezone, currency, "updatedAt")
      VALUES (gen_random_uuid(), ${`role-test-${runId}`}, 'Role Test Tenant', 'ACTIVE', 'Asia/Jakarta', 'IDR', now())
      RETURNING id
    `
    tenantId = tenantRow[0]!.id

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

    // The permission catalog is already seeded above, so ROLE_MANAGE exists.
    // Insert the Owner preset role as a system role to test immutability.
    const roleRow = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO roles (id, "tenantId", name, "isSystem", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'Owner', true, now())
      RETURNING id
    `
    systemRoleId = roleRow[0]!.id

    await dbOwner.$executeRaw`
      INSERT INTO role_permissions ("roleId", "permissionKey")
      VALUES (${systemRoleId}::uuid, ${PERMISSIONS.ROLE_MANAGE})
    `

    const userRow = await dbOwner.$queryRaw<Array<{ id: string }>>`
      INSERT INTO users (id, email, "fullName", status, "passwordHash", "updatedAt")
      VALUES (gen_random_uuid(), ${userEmail}, 'Role Test User', 'ACTIVE', 'unused', now())
      RETURNING id
    `
    userId = userRow[0]!.id

    await dbOwner.$executeRaw`
      INSERT INTO tenant_memberships (id, "tenantId", "userId", "displayName", "employeeCode", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${userId}::uuid, 'Test User', 'EMP-001', now())
    `

    await dbOwner.$executeRaw`
      INSERT INTO user_roles (id, "tenantId", "userId", "roleId", "outletId")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${userId}::uuid, ${systemRoleId}::uuid, NULL)
    `

    const tokenService = new TokenService(config, dbOwner)
    accessToken = (await tokenService.issue({ sub: userId, tenantId, outletId })).accessToken
  })

  afterAll(async () => {
    await dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`
    await dbOwner.$executeRaw`DELETE FROM users WHERE email = ${userEmail}`
    await dbOwner.$disconnect()
    await dbSystem.$disconnect()
  })

  it('creates a custom role and returns it with permissions', async () => {
    const res = await request
      .post('/roles')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'Custom Manager',
        permissions: [PERMISSIONS.ROLE_MANAGE],
      })

    expect(res.status).toBe(201)
    expect(res.body.role).toHaveProperty('id')
    expect(res.body.role.name).toBe('Custom Manager')
    expect(res.body.role.isSystem).toBe(false)
    expect(res.body.role.permissions).toHaveLength(1)
    expect(res.body.role.permissions[0].permissionKey).toBe(PERMISSIONS.ROLE_MANAGE)
  })

  it('lists roles including both custom and system roles', async () => {
    const res = await request
      .get('/roles')
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.roles).toBeInstanceOf(Array)
    expect(res.body.roles.length).toBeGreaterThanOrEqual(2)

    const ownerRole = res.body.roles.find((r: { name: string }) => r.name === 'Owner')
    expect(ownerRole?.isSystem).toBe(true)

    const customRole = res.body.roles.find((r: { name: string }) => r.name === 'Custom Manager')
    expect(customRole?.isSystem).toBe(false)
  })

  it('updates a custom role', async () => {
    const createRes = await request
      .post('/roles')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'Temporary Role',
        permissions: [],
      })

    const roleId = createRes.body.role.id

    const updateRes = await request
      .put(`/roles/${roleId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'Updated Role',
        permissions: [PERMISSIONS.ROLE_MANAGE],
      })

    expect(updateRes.status).toBe(200)
    expect(updateRes.body.role.name).toBe('Updated Role')
    expect(updateRes.body.role.permissions).toHaveLength(1)
  })

  it('rejects updates to system roles with 403', async () => {
    const res = await request
      .put(`/roles/${systemRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'Hacked Owner',
      })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('SYSTEM_ROLE_IMMUTABLE')
  })

  it('deletes a custom role', async () => {
    const createRes = await request
      .post('/roles')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'Deletable Role',
        permissions: [],
      })

    const roleId = createRes.body.role.id

    const deleteRes = await request
      .delete(`/roles/${roleId}`)
      .set('Authorization', `Bearer ${accessToken}`)

    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body.deleted).toBe(true)

    const getRes = await request
      .get(`/roles/${roleId}`)
      .set('Authorization', `Bearer ${accessToken}`)

    expect(getRes.status).toBe(404)
  })

  it('silently refuses to delete system roles', async () => {
    const res = await request
      .delete(`/roles/${systemRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(false)

    const getRes = await request
      .get(`/roles/${systemRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)

    expect(getRes.status).toBe(200)
    expect(getRes.body.role.name).toBe('Owner')
  })
})
