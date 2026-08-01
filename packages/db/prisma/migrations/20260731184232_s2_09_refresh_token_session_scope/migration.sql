-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "scopeOutletId" UUID,
ADD COLUMN     "scopeTenantId" UUID;
