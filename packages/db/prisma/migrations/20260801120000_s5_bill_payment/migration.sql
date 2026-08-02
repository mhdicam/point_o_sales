-- CreateEnum
CREATE TYPE "PaymentMethodKind" AS ENUM ('CASH', 'CARD', 'QRIS', 'EWALLET', 'VOUCHER', 'POINTS', 'OTHER');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('OPEN', 'PAID', 'VOID');

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PaymentMethodKind" NOT NULL DEFAULT 'OTHER',
    "opensCashDrawer" BOOLEAN NOT NULL DEFAULT false,
    "needsRefNo" BOOLEAN NOT NULL DEFAULT false,
    "countsAsCash" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 1,
    "status" "BillStatus" NOT NULL DEFAULT 'OPEN',
    "subtotal" BIGINT NOT NULL,
    "total" BIGINT NOT NULL,
    "label" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "billId" UUID NOT NULL,
    "methodId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "changeGiven" BIGINT NOT NULL DEFAULT 0,
    "refNo" TEXT,
    "reason" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_methods_tenantId_idx" ON "payment_methods"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_tenantId_code_key" ON "payment_methods"("tenantId", "code");

-- CreateIndex
CREATE INDEX "bills_tenantId_idx" ON "bills"("tenantId");

-- CreateIndex
CREATE INDEX "bills_orderId_idx" ON "bills"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "bills_orderId_seq_key" ON "bills"("orderId", "seq");

-- CreateIndex
CREATE INDEX "payments_tenantId_idx" ON "payments"("tenantId");

-- CreateIndex
CREATE INDEX "payments_billId_idx" ON "payments"("billId");

-- CreateIndex
CREATE INDEX "payments_methodId_idx" ON "payments"("methodId");

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_billId_fkey" FOREIGN KEY ("billId") REFERENCES "bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Row-Level Security (standard #1 — RLS is the safety net under the Prisma
-- extension). Mirrors the per-table policy block from the S4 order migration:
-- every new tenant-scoped table gets ENABLE + FORCE + a tenant_isolation policy
-- keyed on the app.current_tenant GUC bound per request/transaction.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'payment_methods',
    'bills',
    'payments'
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
  payment_methods, bills, payments
TO brewsync_app;
