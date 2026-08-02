-- S8-06 — QR self-service order flow (design §16.2).
-- Per-outlet toggle: auto-accept QR orders straight to the kitchen (true) or
-- hold them OPEN for a waiter to accept (false, the spam-safe default).
-- `outlets` is already RLS-enabled and granted; a plain column add touches
-- neither the RLS policy nor the GRANTs.
ALTER TABLE "outlets" ADD COLUMN "qrAutoAccept" BOOLEAN NOT NULL DEFAULT false;
