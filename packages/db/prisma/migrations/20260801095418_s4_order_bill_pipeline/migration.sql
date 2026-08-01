-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'SENT', 'SERVED', 'BILLED', 'PAID', 'CLOSED', 'VOID');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('STAFF', 'QR_TABLE', 'ONLINE');

-- CreateEnum
CREATE TYPE "OrderChargeKind" AS ENUM ('DISCOUNT', 'SERVICE_CHARGE', 'TAX', 'ROUNDING', 'GRATUITY');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "channel" "OrderChannel" NOT NULL DEFAULT 'STAFF',
    "salesMethod" TEXT,
    "sentAt" TIMESTAMP(3),
    "billedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "priceSnapshot" BIGINT NOT NULL DEFAULT 0,
    "nameSnapshot" TEXT NOT NULL DEFAULT '',
    "modifierDeltaSnapshot" BIGINT NOT NULL DEFAULT 0,
    "modifiersSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_charges" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "kind" "OrderChargeKind" NOT NULL,
    "label" TEXT NOT NULL,
    "basis" BIGINT NOT NULL,
    "rateBp" INTEGER,
    "amount" BIGINT NOT NULL,
    "taxable" BOOLEAN NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "orderItemId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orders_tenantId_idx" ON "orders"("tenantId");

-- CreateIndex
CREATE INDEX "orders_outletId_idx" ON "orders"("outletId");

-- CreateIndex
CREATE INDEX "order_items_tenantId_idx" ON "order_items"("tenantId");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_variantId_idx" ON "order_items"("variantId");

-- CreateIndex
CREATE INDEX "order_charges_tenantId_idx" ON "order_charges"("tenantId");

-- CreateIndex
CREATE INDEX "order_charges_orderId_idx" ON "order_charges"("orderId");

-- CreateIndex
CREATE INDEX "order_charges_orderItemId_idx" ON "order_charges"("orderItemId");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_charges" ADD CONSTRAINT "order_charges_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_charges" ADD CONSTRAINT "order_charges_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_charges" ADD CONSTRAINT "order_charges_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-Level Security (standard #1 — RLS is the safety net under the Prisma
-- extension). Mirrors the per-table policy block from the S3 master-product
-- migration: every new tenant-scoped table gets ENABLE + FORCE + a tenant_isolation
-- policy keyed on the app.current_tenant GUC bound per request/transaction.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'orders',
    'order_items',
    'order_charges'
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

-- The runtime role needs DML on the new tables. ALTER DEFAULT PRIVILEGES from
-- the S1-04 migration covers tables created afterwards, but granting explicitly
-- keeps this migration self-contained for a database provisioned out of order.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  orders, order_items, order_charges
TO brewsync_app;
