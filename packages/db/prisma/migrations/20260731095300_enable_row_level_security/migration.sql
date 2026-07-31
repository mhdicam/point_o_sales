-- S1-04 — Row-Level Security: layer two of tenant isolation (standard #1).
--
-- The Prisma extension injects tenantId at the application layer. This makes the
-- database enforce it independently, so a raw query, a model missing from the
-- extension allowlist, or an ORM bug still cannot read across tenants.
--
-- Policies compare tenant_id against the session GUC `app.current_tenant`, which
-- the app sets per transaction via SET LOCAL (see src/client.ts).
--
-- Non-negotiable prerequisite: the *runtime* role must not be superuser, must
-- not own these tables, and must not have BYPASSRLS. Postgres exempts all three
-- silently, which would make these policies inert. FORCE ROW LEVEL SECURITY
-- below additionally subjects the owner to the policy, so a test run as owner
-- cannot report false confidence.

-- Runtime role. Created here so a fresh clone (or CI) provisions it identically.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brewsync_app') THEN
    CREATE ROLE brewsync_app LOGIN PASSWORD 'brewsync_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO brewsync_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO brewsync_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO brewsync_app;

-- Future tables created by the migration role inherit these grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brewsync_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO brewsync_app;

-- Tenant-scoped tables. Keep in sync with RLS_TABLES in src/rls.ts; the
-- isolation test fails loudly if a tenant-owned table is missing here.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'outlets',
    'business_profiles',
    'tenant_memberships',
    'roles',
    'user_roles',
    'outbox_events'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);

    -- Column is "tenantId": @map applies to tables, not fields, so Prisma keeps
    -- the camelCase column name and it must stay quoted here.
    --
    -- current_setting(..., true) returns NULL when unset rather than erroring;
    -- NULL fails the comparison, so "no tenant bound" means "no rows visible"
    -- — fail closed, not open.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)
         WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;
