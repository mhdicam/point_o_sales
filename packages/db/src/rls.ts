/**
 * Postgres Row-Level Security — S1-04, standard #1 layer two.
 *
 * The Prisma extension (src/tenant-scope.ts) is layer one. This is the net under
 * it: even a raw query, a missed model in the allowlist, or a future ORM bug
 * cannot read across tenants, because the database itself filters rows.
 *
 * Mechanics: each policy compares the row's "tenantId" against the session
 * setting `app.current_tenant`. That variable is bound transaction-locally by
 * the tenant-scope extension (src/tenant-scope.ts) and by
 * `withTenantTransaction` (src/client.ts).
 *
 * Critical prerequisite: DATABASE_URL must connect as a role that is neither
 * superuser nor the table owner, and lacks BYPASSRLS. Postgres silently exempts
 * those, which would turn this whole file into decoration. The migration grants
 * the app role exactly DML, no more.
 */

/** SQL emitted by the RLS migration. Kept here so the policy set has one source. */
export function buildRlsStatements(tables: readonly string[], appRole: string): string[] {
  const statements: string[] = []

  for (const table of tables) {
    statements.push(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`)
    // FORCE applies the policy to the table owner too, so a migration run as
    // owner cannot accidentally prove isolation works when it does not.
    statements.push(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`)
    statements.push(`DROP POLICY IF EXISTS tenant_isolation ON "${table}";`)
    statements.push(
      // Quoted "tenantId": Prisma maps model fields to camelCase columns, so the
      // unquoted snake_case form would not resolve.
      //
      // NULLIF(..., '') guards the unset case: current_setting(..., true)
      // returns '' rather than NULL when the GUC was never set, and ''::uuid
      // raises instead of failing closed. With NULLIF the comparison is NULL,
      // which is falsy — no GUC means no rows, never all rows.
      `CREATE POLICY tenant_isolation ON "${table}"\n` +
        `  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)\n` +
        `  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);`
    )
  }

  statements.push(`GRANT USAGE ON SCHEMA public TO ${appRole};`)
  statements.push(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole};`
  )
  statements.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole};`)

  return statements
}

/** Table names (snake_case, as mapped in schema.prisma) that carry tenant_id. */
export const RLS_TABLES = [
  'outlets',
  'business_profiles',
  'tenant_memberships',
  'roles',
  'user_roles',
  'outbox_events',
  // Master product — S3
  'units',
  'categories',
  'products',
  'product_images',
  'product_variants',
  'modifier_groups',
  'modifiers',
  'product_modifier_groups',
  'price_lists',
  'price_list_items',
  // Order — S4
  'orders',
  'order_items',
  'order_charges',
  // Payment — S5
  'payment_methods',
  'bills',
  'payments',
  // Shift — S5
  'shifts',
  'cash_movements',
  // Sales method — S7
  'sales_methods',
  // Floor plan — S7
  'areas',
  'tables',
  // KDS — S7
  'stations',
  // Inventory & purchasing — S6
  'stock_movements',
  'recipes',
  'recipe_items',
  'suppliers',
  'purchase_orders',
  'purchase_order_items',
] as const
