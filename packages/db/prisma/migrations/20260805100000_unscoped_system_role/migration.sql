-- Dedicated unscoped/system role — the one sanctioned cross-tenant read path.
--
-- Background (standard #1/#4): `runUnscoped` in the app tells the Prisma
-- tenant-scope extension to skip tenantId injection. It does NOT bind the
-- `app.current_tenant` GUC and it does NOT exempt the connection from RLS. The
-- runtime role `brewsync_app` is NOBYPASSRLS and every tenant table is FORCE ROW
-- LEVEL SECURITY with a fail-closed policy, so an unscoped read with no GUC bound
-- returns ZERO rows. That is correct for the app role — but it breaks the genuine
-- pre-tenant / cross-tenant reads (public landing slug resolve, QR table resolve,
-- the outbox worker sweep, the login membership list), which have no tenant to
-- bind yet and legitimately span tenants.
--
-- Rather than weaken the per-tenant policy (allowing unset-GUC reads would make
-- the fail-closed invariant meaningless), we add ONE dedicated role that Postgres
-- exempts from RLS: `brewsync_system` with BYPASSRLS. A single dedicated client
-- uses it for exactly those reads. The app role stays strictly RLS-subject.
--
-- BYPASSRLS is the only privilege that matters here. The role is NOT superuser,
-- NOT a table owner, and is intentionally NOT granted DML — cross-tenant *writes*
-- are out of scope by design (a write always happens inside a bound tenant tx).
-- SELECT is granted so the role can actually read; that plus BYPASSRLS is the
-- whole capability.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brewsync_system') THEN
    CREATE ROLE brewsync_system LOGIN PASSWORD 'brewsync_system'
      NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO brewsync_system;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO brewsync_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO brewsync_system;

-- Future tables created by the migration role inherit read access.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO brewsync_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO brewsync_system;
