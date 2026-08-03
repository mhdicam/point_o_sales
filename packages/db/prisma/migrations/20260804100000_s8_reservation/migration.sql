-- S8-01 — Reservation (design §15). One model, two faces: F&B books a table +
-- arrival time; Service books a slot + staff. A deposit rides the ordinary
-- Payment path (minor units, standard #2); `orderId` is filled at SEATED when
-- the booking hands off to a live Order. Anti double-booking (§15.3) is enforced
-- in the service. RLS + GRANT as prior sprints.

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'SEATED', 'COMPLETED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationSource" AS ENUM ('STAFF', 'ONLINE');

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "source" "ReservationSource" NOT NULL DEFAULT 'STAFF',
    "status" "ReservationStatus" NOT NULL DEFAULT 'REQUESTED',
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerEmail" TEXT,
    "partySize" INTEGER NOT NULL,
    "reservedFor" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER,
    "tableId" UUID,
    "assignedStaffId" UUID,
    "depositAmount" BIGINT,
    "depositPaymentId" UUID,
    "notes" TEXT,
    "orderId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" UUID,
    "confirmedAt" TIMESTAMP(3),
    "seatedAt" TIMESTAMP(3),

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One booking maps to at most one live Order (filled at SEATED).
CREATE UNIQUE INDEX "reservations_orderId_key" ON "reservations"("orderId");

-- CreateIndex
CREATE INDEX "reservations_tenantId_idx" ON "reservations"("tenantId");

-- CreateIndex
CREATE INDEX "reservations_outletId_idx" ON "reservations"("outletId");

-- CreateIndex
CREATE INDEX "reservations_tableId_idx" ON "reservations"("tableId");

-- CreateIndex
-- Drives the §15.3 overlap query: CONFIRMED rows for a table in a time window.
CREATE INDEX "reservations_tableId_status_idx" ON "reservations"("tableId", "status");

-- CreateIndex
CREATE INDEX "reservations_assignedStaffId_status_idx" ON "reservations"("assignedStaffId", "status");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Row-Level Security (standard #1). Same per-table policy block as prior sprints.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'reservations'
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
  reservations
TO brewsync_app;
