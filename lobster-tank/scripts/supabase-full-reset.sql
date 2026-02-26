-- Full reset script for Supabase: 10 aquariums + optional cleanup.
-- Run in Supabase SQL editor (or migrations). Idempotent where noted.
--
-- After running the OPTIONAL blocks below: either restart your Next.js server
-- so the in-memory sim reloads from DB, or use "Empty tank (testing)" in the UI
-- (when NEXT_PUBLIC_SHOW_RESET_TANK=true) to force an empty tank immediately.

-- 1) Ensure 10 aquariums exist (idempotent)
INSERT INTO "Aquarium" (id, name, "maxLobsters", "createdAt", "updatedAt")
VALUES
  ('global', 'Global Tank', 120, NOW(), NOW()),
  ('aquarium-2', 'Aquarium 2', 120, NOW(), NOW()),
  ('aquarium-3', 'Aquarium 3', 120, NOW(), NOW()),
  ('aquarium-4', 'Aquarium 4', 120, NOW(), NOW()),
  ('aquarium-5', 'Aquarium 5', 120, NOW(), NOW()),
  ('aquarium-6', 'Aquarium 6', 120, NOW(), NOW()),
  ('aquarium-7', 'Aquarium 7', 120, NOW(), NOW()),
  ('aquarium-8', 'Aquarium 8', 120, NOW(), NOW()),
  ('aquarium-9', 'Aquarium 9', 120, NOW(), NOW()),
  ('aquarium-10', 'Aquarium 10', 120, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  "maxLobsters" = EXCLUDED."maxLobsters",
  "updatedAt" = NOW();

-- 2) Clear AI narrator posts (so summaries match fresh state)
DELETE FROM "NarratorPost";

INSERT INTO "Aquarium" (id, name, "maxLobsters", "createdAt", "updatedAt")
VALUES ('staging', 'Staging (empty)', 500, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

UPDATE "Lobster"
SET "aquariumId" = 'staging'
WHERE "aquariumId" = 'global';

DELETE FROM "TankSnapshot";

