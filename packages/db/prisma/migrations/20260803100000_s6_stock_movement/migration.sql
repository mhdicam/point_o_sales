-- S6-01 — StockMovement, the append-only inventory ledger (design §4.1, standard #3).
-- On-hand is SUM(qty); there is deliberately no stockOnHand column.

-- CreateEnum
-- What drove a stock change. The qty sign is authoritative; this is descriptive.
CREATE TYPE "StockMovementType" AS ENUM (
  'PURCHASE',
  'SALE_CONSUMPTION',
  'WASTE',
  'TRANSFER',
  'ADJUSTMENT',
  'PRODUCTION'
);

-- CreateTable
-- qty is signed, in SCALED BASE UNITS (base × UNIT_FACTOR_SCALE) so fractional
-- recipe amounts stay exact integers through a deep recipe chain (§3.2 trick).
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "qty" BIGINT NOT NULL,
    "costPerUnit" BIGINT,
    "refType" TEXT,
    "refId" UUID,
    "reason" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_movements_tenantId_idx" ON "stock_movements"("tenantId");

-- CreateIndex
-- The on-hand query path: SUM(qty) WHERE outletId = ? AND variantId = ?.
CREATE INDEX "stock_movements_outletId_variantId_idx" ON "stock_movements"("outletId", "variantId");

-- CreateIndex
-- The idempotency path: has this (order) already produced consumption rows?
CREATE INDEX "stock_movements_refType_refId_idx" ON "stock_movements"("refType", "refId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict: a variant with stock history cannot be hard-deleted (deactivate instead).
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Row-Level Security (standard #1). Same per-table policy block as prior sprints.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'stock_movements'
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
  stock_movements
TO brewsync_app;
