-- S6-03 — Recipe / BOM, recursive via componentType (design §3.4, standard #3 feeds it).
-- A Recipe is 1:1 with the ProductVariant it produces; RecipeItem lines point at a
-- component ProductVariant (INGREDIENT stops, PRODUCT recurses) in a recipe Unit.
-- Quantities are scaled integers (UNIT_FACTOR_SCALE) so a deep chain never drifts.

-- CreateEnum
CREATE TYPE "RecipeComponentType" AS ENUM (
  'INGREDIENT',
  'PRODUCT'
);

-- CreateTable
CREATE TABLE "recipes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "yieldQtyScaled" BIGINT NOT NULL DEFAULT 1000000,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "recipeId" UUID NOT NULL,
    "componentVariantId" UUID NOT NULL,
    "componentType" "RecipeComponentType" NOT NULL,
    "qtyScaled" BIGINT NOT NULL,
    "recipeUnitId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipe_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One recipe per variant (ProductVariant ||--o| Recipe).
CREATE UNIQUE INDEX "recipes_variantId_key" ON "recipes"("variantId");

-- CreateIndex
CREATE INDEX "recipes_tenantId_idx" ON "recipes"("tenantId");

-- CreateIndex
CREATE INDEX "recipe_items_tenantId_idx" ON "recipe_items"("tenantId");

-- CreateIndex
CREATE INDEX "recipe_items_recipeId_idx" ON "recipe_items"("recipeId");

-- CreateIndex
-- Reverse lookup: which recipes use this variant as a component.
CREATE INDEX "recipe_items_componentVariantId_idx" ON "recipe_items"("componentVariantId");

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Deleting a variant removes its recipe with it.
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict: a variant referenced as a component cannot be hard-deleted.
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_componentVariantId_fkey" FOREIGN KEY ("componentVariantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict: a unit used by a recipe line cannot be hard-deleted.
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_recipeUnitId_fkey" FOREIGN KEY ("recipeUnitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Row-Level Security (standard #1). Same per-table policy block as prior sprints.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'recipes',
    'recipe_items'
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
  recipes,
  recipe_items
TO brewsync_app;
