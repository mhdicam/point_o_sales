/**
 * Onboarding integration test — S2-08.
 *
 * Validates the full tenant provisioning flow: tenant → BusinessProfile →
 * preset roles → outlet → owner user + membership + role assignment, all in one
 * transaction. Also tests the platform token guard and the two 409 pre-checks.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import { createApp } from '../src/app.js'
import { runUnscoped, createPrismaClient, seedPermissionCatalog } from '@brewsync/db'
import { PrismaClient } from '@brewsync/db'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') })

describe('Onboarding', () => {
  const config = loadConfig({ ...process.env, PLATFORM_API_TOKEN: 'test-platform-token-12345' })
  const logger = createLogger(config)
  const dbOwner = createPrismaClient({ datasourceUrl: process.env.TEST_DIRECT_DATABASE_URL ?? '' })
  const app = createApp(dbOwner, config, logger)
  const request = supertest(app)

  // Fixtures are namespaced per run so a failed test leaves no collision on retry.
  const runId = randomUUID().slice(0, 8)
  const slug = `tenant-${runId}`
  const email = `owner-${runId}@test.local`

  let tenantId: string

  beforeAll(async () => {
    // Permission is a global model with no tenantId, so it needs seeding before
    // any role can reference it. The catalog is idempotent — running this in
    // every test suite that needs it is cheaper than coordinating one seed.
    const plainClient = new PrismaClient({
      datasourceUrl: process.env.TEST_DIRECT_DATABASE_URL,
    })
    await seedPermissionCatalog(plainClient)
    await plainClient.$disconnect()
  })

  afterAll(async () => {
    // Tenant deletion cascades to outlet, roles, role_permissions, membership, user_roles.
    // The owner user is global and needs deleting explicitly.
    await runUnscoped(async () => {
      if (tenantId) {
        await dbOwner.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`
      }
      await dbOwner.$executeRaw`DELETE FROM users WHERE email = ${email}`
    })
    await dbOwner.$disconnect()
  })

  it('provisions a tenant with the FNB preset and returns the full topology', async () => {
    const res = await request
      .post('/onboarding/tenants')
      .set('Authorization', 'Bearer test-platform-token-12345')
      .send({
        slug,
        name: 'Test Cafe',
        preset: 'FNB',
        timezone: 'Asia/Jakarta',
        currency: 'IDR',
        outlet: {
          code: 'MAIN',
          name: 'Main Outlet',
        },
        owner: {
          email,
          fullName: 'Test Owner',
        },
        featureOverrides: {
          qrOrder: false,
        },
      })

    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('tenantId')
    expect(res.body).toHaveProperty('outletId')
    expect(res.body).toHaveProperty('ownerUserId')
    expect(res.body).toHaveProperty('ownerMembershipId')
    expect(res.body.preset).toBe('FNB')
    expect(res.body.features).toMatchObject({
      tables: true,
      kds: true,
      modifiers: true,
      qrOrder: false, // overridden from the FNB default (true)
    })
    expect(res.body.roleIds).toHaveProperty('Owner')
    expect(res.body.roleIds).toHaveProperty('Manajer Outlet')
    expect(res.body.roleIds).toHaveProperty('Supervisor Shift')
    expect(res.body.roleIds).toHaveProperty('Kasir')

    tenantId = res.body.tenantId

    // Verify the tenant, profile, outlet, and owner were actually written.
    const tenant = await runUnscoped(() =>
      dbOwner.tenant.findUnique({ where: { id: tenantId } })
    )

    expect(tenant).toBeTruthy()
    expect(tenant!.slug).toBe(slug)
    expect(tenant!.timezone).toBe('Asia/Jakarta')

    // RLS is FORCEd, so the owner role is subject to it too. runUnscoped skips
    // the extension's GUC binding, which makes tenant-scoped reads fail closed to
    // zero rows. Binding the GUC session-wide is what lets the assertions below
    // see the rows the transaction wrote. Tenant itself is global, so the read
    // above needed no binding.
    await runUnscoped(async () => {
      await dbOwner.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant', $1, false)`,
        tenantId
      )
    })

    const profile = await runUnscoped(async () =>
      dbOwner.businessProfile.findUnique({ where: { tenantId } })
    )
    expect(profile?.preset).toBe('FNB')

    const outlet = await runUnscoped(async () =>
      dbOwner.outlet.findUnique({ where: { id: res.body.outletId } })
    )
    expect(outlet?.code).toBe('MAIN')

    const owner = await runUnscoped(async () =>
      dbOwner.user.findUnique({ where: { id: res.body.ownerUserId } })
    )
    expect(owner?.email).toBe(email)
    expect(owner?.status).toBe('INVITED')
    expect(owner?.passwordHash).toBeNull()

    const membership = await runUnscoped(async () =>
      dbOwner.tenantMembership.findUnique({ where: { id: res.body.ownerMembershipId } })
    )
    expect(membership?.employeeCode).toBe('EMP-001')

    // Verify the owner has the Owner role with tenant-wide scope (outletId null).
    const ownerRoleAssignment = await runUnscoped(async () =>
      dbOwner.userRole.findFirst({
        where: { userId: res.body.ownerUserId, roleId: res.body.roleIds.Owner },
      })
    )
    expect(ownerRoleAssignment?.outletId).toBeNull()
  })

  it('rejects a duplicate slug with 409 SLUG_TAKEN', async () => {
    const res = await request
      .post('/onboarding/tenants')
      .set('Authorization', 'Bearer test-platform-token-12345')
      .send({
        slug, // same slug as the successful test above
        name: 'Another Cafe',
        preset: 'RETAIL',
        outlet: { code: 'MAIN', name: 'Main' },
        owner: { email: `different-${runId}@test.local`, fullName: 'Different Owner' },
      })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('SLUG_TAKEN')
  })

  it('rejects a duplicate owner email with 409 EMAIL_TAKEN', async () => {
    const res = await request
      .post('/onboarding/tenants')
      .set('Authorization', 'Bearer test-platform-token-12345')
      .send({
        slug: `different-${runId}`,
        name: 'Yet Another Cafe',
        preset: 'SERVICE',
        outlet: { code: 'MAIN', name: 'Main' },
        owner: { email, fullName: 'Test Owner' }, // same email as the successful test
      })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('EMAIL_TAKEN')
  })

  it('rejects a request with no platform token', async () => {
    const res = await request.post('/onboarding/tenants').send({
      slug: `no-token-${runId}`,
      name: 'No Token Cafe',
      preset: 'FNB',
      outlet: { code: 'MAIN', name: 'Main' },
      owner: { email: `no-token-${runId}@test.local`, fullName: 'No Token' },
    })

    expect(res.status).toBe(401)
  })

  it('rejects a request with the wrong platform token', async () => {
    const res = await request
      .post('/onboarding/tenants')
      .set('Authorization', 'Bearer wrong-token')
      .send({
        slug: `wrong-token-${runId}`,
        name: 'Wrong Token Cafe',
        preset: 'FNB',
        outlet: { code: 'MAIN', name: 'Main' },
        owner: { email: `wrong-token-${runId}@test.local`, fullName: 'Wrong Token' },
      })

    expect(res.status).toBe(401)
  })
})
