-- Reset database for production launch.
-- Wipes all lobsters, events, stories, snapshots, communities, and users.
-- Run: psql $DATABASE_URL -f scripts/reset-for-launch.sql
-- Or paste into Supabase SQL editor.

BEGIN;

-- Delete events first (FK dependencies)
DELETE FROM "FeedEvent";
DELETE FROM "PetEvent";
DELETE FROM "InstantRespawnEvent";
DELETE FROM "TankEvent";

-- Delete narrator stories
DELETE FROM "NarratorPost";

-- Delete tank snapshots (sim state cache)
DELETE FROM "TankSnapshot";

-- Delete lobsters (FK to User, Aquarium, Community)
DELETE FROM "Lobster";

-- Delete communities
DELETE FROM "Community";

-- Delete users (fresh start)
DELETE FROM "User";

-- Ensure "global" aquarium exists
INSERT INTO "Aquarium" (id, name, "maxLobsters", "createdAt", "updatedAt")
VALUES ('global', 'Global Tank', 120, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET "maxLobsters" = 120, "updatedAt" = NOW();

COMMIT;
