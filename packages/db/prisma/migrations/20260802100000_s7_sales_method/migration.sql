-- CreateEnum
CREATE TYPE "SalesMethodKind" AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY');

-- CreateTable
-- A tenant-owned sales method (§6 — dine-in / takeaway / delivery). Orders and
-- price lists reference it by `code` (a plain string, matching the existing
-- PriceList seam), never by FK, so historical orders keep their method label
-- even if the row is renamed or deactivated.
--
-- The fiscal columns (taxRateBp / serviceChargeRateBp / taxInclusive) are
-- nullable and NO-OP for S7: tax and service charge still come from Outlet
-- (+ Category.defaultTaxRateBp). They ship now so the override precedence can be
-- wired in a later sprint without a second migration; until then order.fiscal.ts
-- is an identity passthrough and no order's tax shifts.
CREATE TABLE "sales_methods" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SalesMethodKind" NOT NULL,
    "taxRateBp" INTEGER,
    "serviceChargeRateBp" INTEGER,
    "taxInclusive" BOOLEAN,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_methods_tenantId_idx" ON "sales_methods"("tenantId");

-- CreateIndex
-- Orders join on (tenant, code); the pair must be unique within a tenant.
CREATE UNIQUE INDEX "sales_methods_tenantId_code_key" ON "sales_methods"("tenantId", "code");

-- AddForeignKey
ALTER TABLE "sales_methods" ADD CONSTRAINT "sales_methods_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-Level Security (standard #1). Same per-table policy block as the S5
-- migrations: ENABLE + FORCE + tenant_isolation keyed on the app.current_tenant GUC.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'sales_methods'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)
         WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;

-- The runtime role needs DML on the new table (self-contained for a database
-- provisioned out of order; ALTER DEFAULT PRIVILEGES from S1-04 also covers it).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  sales_methods
TO brewsync_app;
