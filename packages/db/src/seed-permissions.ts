/**
 * Permission catalog seeding — S2-01.
 *
 * The catalog is code-owned reference data, not tenant data: `Permission` has no
 * `tenantId` and every `RolePermission` row carries a foreign key into it. Any
 * database that will hold roles needs it present, which includes CI and the test
 * database, not just a developer's seeded dev box.
 *
 * Split out from prisma/seed.ts so callers can get the catalog without the demo
 * tenants that script also creates.
 */

import { PERMISSION_DEFINITIONS } from '@brewsync/shared'
import type { PrismaClient } from '../generated/client/index.js'

/**
 * Upserts every permission in the catalog. Idempotent — safe to run on every
 * deploy, which is how new permissions reach an existing database (design §12.4).
 *
 * Takes a plain `PrismaClient` rather than the extended client: `Permission` is a
 * global model, so there is no tenant context to bind.
 */
export async function seedPermissionCatalog(prisma: PrismaClient): Promise<number> {
  for (const def of PERMISSION_DEFINITIONS) {
    await prisma.permission.upsert({
      where: { key: def.key },
      update: { domain: def.domain, description: def.description },
      create: def,
    })
  }
  return PERMISSION_DEFINITIONS.length
}
