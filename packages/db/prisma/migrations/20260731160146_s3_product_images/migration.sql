-- ---------------------------------------------------------------------------
-- S3-03 (reopened) — multi-image for products.
--
-- `products."imageUrl"` held at most one image. It is replaced by a child table
-- rather than kept alongside it: two places holding "the product's picture" is a
-- dual source of truth, and the one that drifts is always the denormalized one.
--
-- Order matters here. The table is created and back-filled BEFORE the column is
-- dropped, so an existing single image becomes the cover row instead of being
-- discarded. Prisma's generated draft dropped the column first; that ordering
-- was rewritten by hand.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "isCover" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_images_tenantId_idx" ON "product_images"("tenantId");

-- CreateIndex
CREATE INDEX "product_images_productId_idx" ON "product_images"("productId");

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Back-fill: every non-empty products."imageUrl" becomes that product's cover.
-- Runs as the migration role (owner), before RLS is enabled on the new table,
-- so no `app.current_tenant` GUC is needed for these inserts.
-- ---------------------------------------------------------------------------
INSERT INTO "product_images" ("id", "tenantId", "productId", "url", "isCover", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid(), p."tenantId", p."id", p."imageUrl", true, 0, now(), now()
FROM "products" p
WHERE p."imageUrl" IS NOT NULL AND btrim(p."imageUrl") <> '';

-- AlterTable
ALTER TABLE "products" DROP COLUMN "imageUrl";

-- ---------------------------------------------------------------------------
-- Row-Level Security (standard #1, layer two).
--
-- A tenant-owned table that is not covered here is readable across tenants at
-- the database layer — the Prisma extension would still filter it, but the
-- safety net would have a hole. Keep in sync with RLS_TABLES in src/rls.ts.
-- ---------------------------------------------------------------------------
ALTER TABLE "product_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_images" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "product_images";
CREATE POLICY tenant_isolation ON "product_images"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ALTER DEFAULT PRIVILEGES from the S1-04 migration already covers tables
-- created afterwards; granting explicitly keeps this migration self-contained
-- for a database provisioned out of order.
GRANT SELECT, INSERT, UPDATE, DELETE ON "product_images" TO brewsync_app;
