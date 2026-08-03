-- S6-05 — Supplier master (design §4.4). Tenant-level vendor, shared across
-- outlets. Carries the purchasing/Accounting fields (paymentTermDays, taxId/NPWP);
-- per-item buy prices live on PO lines, not here (§4.4). RLS + GRANT as prior sprints.

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "taxId" TEXT,
    "paymentTermDays" INTEGER NOT NULL DEFAULT 0,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'IDR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" UUID,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Internal code unique per tenant.
CREATE UNIQUE INDEX "suppliers_tenantId_code_key" ON "suppliers"("tenantId", "code");

-- CreateIndex
CREATE INDEX "suppliers_tenantId_idx" ON "suppliers"("tenantId");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-Level Security (standard #1). Same per-table policy block as prior sprints.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'suppliers'
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

-- The runtime role needs DML on the new table.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  suppliers
TO brewsync_app;
