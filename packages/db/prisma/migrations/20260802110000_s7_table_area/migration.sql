-- CreateEnum
CREATE TYPE "AreaKind" AS ENUM ('AREA', 'FLOOR');

-- CreateEnum
CREATE TYPE "TableStatus" AS ENUM ('EMPTY', 'OCCUPIED', 'RESERVED', 'DIRTY');

-- CreateTable
-- Hierarchical layout (Area/Floor → Area/Section) for tables. Self-referencing:
-- a "Floor" area (kind = FLOOR) has no parent; nested "Area" rows (kind = AREA)
-- represent sections within a floor. Design §5.4 + §19 responsive denah meja.
CREATE TABLE "areas" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "parentId" UUID,
    "kind" "AreaKind" NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- A physical table. §5.4: one table = one active order at a time (enforced by a
-- partial unique index on orders.tableId below). qrToken is a random token for QR
-- order self-service (§16.2) — never a guessable table number.
CREATE TABLE "tables" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "areaId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TableStatus" NOT NULL DEFAULT 'EMPTY',
    "capacity" INTEGER,
    "qrToken" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "areas_tenantId_idx" ON "areas"("tenantId");

-- CreateIndex
CREATE INDEX "areas_outletId_idx" ON "areas"("outletId");

-- CreateIndex
CREATE INDEX "areas_parentId_idx" ON "areas"("parentId");

-- CreateIndex
CREATE INDEX "tables_tenantId_idx" ON "tables"("tenantId");

-- CreateIndex
CREATE INDEX "tables_outletId_idx" ON "tables"("outletId");

-- CreateIndex
CREATE INDEX "tables_areaId_idx" ON "tables"("areaId");

-- CreateIndex
-- Table code unique per outlet (the physical identifier, e.g. "T1", "BAR-3").
CREATE UNIQUE INDEX "tables_outletId_code_key" ON "tables"("outletId", "code");

-- CreateIndex
-- qrToken unique globally (the URL token must resolve to exactly one table).
CREATE UNIQUE INDEX "tables_qrToken_key" ON "tables"("qrToken");

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable (add Order.tableId FK)
ALTER TABLE "orders" ADD COLUMN "tableId" UUID;

-- CreateIndex
CREATE INDEX "orders_tableId_idx" ON "orders"("tableId");

-- At most one active order per table at a time (§5.4). The set {OPEN, SENT,
-- SERVED, BILLED} is PRE_PAID; once PAID/CLOSED/VOID the table is free. Prisma
-- cannot express a partial unique index, so it is hand-authored here.
CREATE UNIQUE INDEX "orders_one_per_table"
  ON "orders" ("tableId")
  WHERE "tableId" IS NOT NULL AND "status" IN ('OPEN', 'SENT', 'SERVED', 'BILLED');

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Row-Level Security (standard #1). Same per-table policy block as S5/S7-01.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'areas',
    'tables'
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

-- The runtime role needs DML on the new tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  areas, tables
TO brewsync_app;
