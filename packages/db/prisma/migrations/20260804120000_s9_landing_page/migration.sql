-- S9-01 — Landing page + CMS (design §17.1). Two models: a per-tenant (or
-- per-outlet) public `LandingPage` and its ordered `LandingSection` blocks. The
-- public endpoint serves only the PUBLISHED version; `slug` is resolved unscoped
-- (like `Table.qrToken`) then binds to the resolved tenant. Both tables carry
-- `tenantId` and get the standard RLS isolation policy — `landing_sections`
-- follows the same self-scoped pattern as every other child table (order_items,
-- recipe_items, …) so the tenant-scope extension binds the GUC on direct queries
-- and the RLS_TABLES ↔ TENANT_SCOPED_MODELS invariant holds. RLS + GRANT as prior
-- sprints.

-- CreateEnum
CREATE TYPE "LandingSectionType" AS ENUM ('HERO', 'CATALOG', 'ABOUT', 'GALLERY', 'CONTACT', 'HOURS', 'MAP', 'CUSTOM');

-- CreateEnum
CREATE TYPE "LandingPageStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "landing_pages" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "outletId" UUID,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "theme" JSONB,
    "orderingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "LandingPageStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "updatedBy" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "landing_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landing_sections" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "landingPageId" UUID NOT NULL,
    "type" "LandingSectionType" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT,
    "content" JSONB NOT NULL,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "landing_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "landing_pages_tenantId_slug_key" ON "landing_pages"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "landing_pages_tenantId_idx" ON "landing_pages"("tenantId");

-- CreateIndex
CREATE INDEX "landing_pages_outletId_idx" ON "landing_pages"("outletId");

-- CreateIndex
-- Admin drag-order is unique per page.
CREATE UNIQUE INDEX "landing_sections_landingPageId_position_key" ON "landing_sections"("landingPageId", "position");

-- CreateIndex
CREATE INDEX "landing_sections_tenantId_idx" ON "landing_sections"("tenantId");

-- CreateIndex
CREATE INDEX "landing_sections_landingPageId_idx" ON "landing_sections"("landingPageId");

-- AddForeignKey
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landing_sections" ADD CONSTRAINT "landing_sections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landing_sections" ADD CONSTRAINT "landing_sections_landingPageId_fkey" FOREIGN KEY ("landingPageId") REFERENCES "landing_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-Level Security (standard #1). Both tables carry "tenantId" and get the
-- same per-table isolation policy as prior sprints.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'landing_pages',
    'landing_sections'
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
  landing_pages,
  landing_sections
TO brewsync_app;
