-- CreateEnum
-- Per-item KDS lane (§5.1). VOID is the individual-item cancel from voidItem.
CREATE TYPE "KdsStatus" AS ENUM ('QUEUED', 'PREPARING', 'READY', 'SERVED', 'VOID');

-- CreateTable
-- A KDS prep station (kitchen, bar, dessert) owned by an outlet (§5.5). A category
-- routes to one via defaultStationId; a MADE_TO_ORDER item lands here at SENT.
CREATE TABLE "stations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stations_tenantId_idx" ON "stations"("tenantId");

-- CreateIndex
CREATE INDEX "stations_outletId_idx" ON "stations"("outletId");

-- CreateIndex
-- Station name unique per outlet (the operator-facing label, e.g. "Bar", "Dapur").
CREATE UNIQUE INDEX "stations_outletId_name_key" ON "stations"("outletId", "name");

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable (categories.defaultStationId gains its FK — the column already exists
-- from S3 as a plain uuid, foreseen for this sprint; wire it to stations now).
ALTER TABLE "categories" ADD CONSTRAINT "categories_defaultStationId_fkey" FOREIGN KEY ("defaultStationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "categories_defaultStationId_idx" ON "categories"("defaultStationId");

-- AlterTable (order_items KDS routing, resolved at SENT).
ALTER TABLE "order_items" ADD COLUMN "stationId" UUID;
ALTER TABLE "order_items" ADD COLUMN "kdsStatus" "KdsStatus";

-- CreateIndex
CREATE INDEX "order_items_stationId_idx" ON "order_items"("stationId");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Row-Level Security (standard #1). Same per-table policy block as S7-02.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'stations'
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
  stations
TO brewsync_app;
