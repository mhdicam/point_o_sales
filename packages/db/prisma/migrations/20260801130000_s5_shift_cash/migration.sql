-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('OPENING_FLOAT', 'CASH_SALE', 'CASH_REFUND', 'PAID_IN', 'PAID_OUT', 'DROP');

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "registerId" TEXT,
    "openedByUserId" UUID NOT NULL,
    "openingFloat" BIGINT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedByUserId" UUID,
    "closingCountedCash" BIGINT,
    "expectedCash" BIGINT,
    "cashVariance" BIGINT,
    "closedAt" TIMESTAMP(3),
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "refType" TEXT,
    "refId" UUID,
    "reason" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shifts_tenantId_idx" ON "shifts"("tenantId");

-- CreateIndex
CREATE INDEX "shifts_outletId_idx" ON "shifts"("outletId");

-- CreateIndex
CREATE INDEX "cash_movements_tenantId_idx" ON "cash_movements"("tenantId");

-- CreateIndex
CREATE INDEX "cash_movements_shiftId_idx" ON "cash_movements"("shiftId");

-- At most one OPEN shift per (outlet, registerId) at a time (§14.1). Prisma
-- cannot express a partial unique index, so it is hand-authored here. COALESCE
-- collapses a null registerId to the nil UUID so the outlet's single drawer is
-- still covered by the constraint.
CREATE UNIQUE INDEX "shifts_one_open_per_register"
  ON "shifts" ("outletId", COALESCE("registerId", ''))
  WHERE "status" = 'OPEN';

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-Level Security (standard #1). Same per-table policy block as the S5
-- bill/payment migration: ENABLE + FORCE + tenant_isolation keyed on the
-- app.current_tenant GUC.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'shifts',
    'cash_movements'
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

-- The runtime role needs DML on the new tables (self-contained for a database
-- provisioned out of order; ALTER DEFAULT PRIVILEGES from S1-04 also covers them).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  shifts, cash_movements
TO brewsync_app;
