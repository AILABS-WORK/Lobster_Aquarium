-- ============================================================================
-- LOBSTER TANK — FULL DATABASE SETUP (Supabase / PostgreSQL)
-- ============================================================================
-- Paste this ENTIRE file into Supabase SQL Editor and click "Run".
-- It will:
--   1. Create all tables (safe: IF NOT EXISTS)
--   2. Add all columns, indexes, and foreign keys
--   3. Wipe ALL existing data (clean slate for launch)
--   4. Create the "Global Tank" aquarium
--   5. Create the Prisma migrations tracking table so Prisma doesn't complain
-- ============================================================================

BEGIN;

-- ─── 1. CREATE TABLES ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL,
    "twitterId" TEXT,
    "handle" TEXT,
    "avatar" TEXT,
    "walletAddress" TEXT,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Aquarium" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxLobsters" INTEGER NOT NULL DEFAULT 120,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Aquarium_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Community" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Community_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Lobster" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "aquariumId" TEXT NOT NULL DEFAULT 'global',
    "level" INTEGER NOT NULL DEFAULT 1,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "size" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "traits" JSONB,
    "status" TEXT NOT NULL DEFAULT 'Neutral',
    "communityId" TEXT,
    "leftCommunityAt" TIMESTAMP(3),
    "lastFed" TIMESTAMP(3),
    "lastPet" TIMESTAMP(3),
    "petBoostUntil" TIMESTAMP(3),
    "displayName" TEXT,
    "bodyColor" TEXT,
    "clawColor" TEXT,
    "bandanaColor" TEXT,
    "maxHp" INTEGER NOT NULL DEFAULT 100,
    "attackDamage" INTEGER NOT NULL DEFAULT 10,
    "friendshipChance" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "attackHitChance" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "critChance" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "pendingLevelUpLevel" INTEGER,
    "feedCredits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Lobster_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FeedEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lobsterId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PetEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lobsterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PetEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TankEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TankEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TankSnapshot" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "aquariumId" TEXT NOT NULL DEFAULT 'global',
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TankSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "NarratorPost" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NarratorPost_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "InstantRespawnEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lobsterId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InstantRespawnEvent_pkey" PRIMARY KEY ("id")
);

-- ─── 2. UNIQUE INDEXES ─────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "User_twitterId_key" ON "User"("twitterId");
CREATE UNIQUE INDEX IF NOT EXISTS "FeedEvent_txHash_key" ON "FeedEvent"("txHash");
CREATE UNIQUE INDEX IF NOT EXISTS "TankSnapshot_aquariumId_key" ON "TankSnapshot"("aquariumId");
CREATE UNIQUE INDEX IF NOT EXISTS "InstantRespawnEvent_txHash_key" ON "InstantRespawnEvent"("txHash");

-- ─── 3. FOREIGN KEYS (safe: skip if already exists) ────────────────────────

DO $$ BEGIN
  ALTER TABLE "Lobster" ADD CONSTRAINT "Lobster_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Lobster" ADD CONSTRAINT "Lobster_aquariumId_fkey"
    FOREIGN KEY ("aquariumId") REFERENCES "Aquarium"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Lobster" ADD CONSTRAINT "Lobster_communityId_fkey"
    FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "FeedEvent" ADD CONSTRAINT "FeedEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "FeedEvent" ADD CONSTRAINT "FeedEvent_lobsterId_fkey"
    FOREIGN KEY ("lobsterId") REFERENCES "Lobster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PetEvent" ADD CONSTRAINT "PetEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PetEvent" ADD CONSTRAINT "PetEvent_lobsterId_fkey"
    FOREIGN KEY ("lobsterId") REFERENCES "Lobster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── 4. ADD MISSING COLUMNS (safe: IF NOT EXISTS) ──────────────────────────
-- These handle the case where tables existed from an older schema

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "aquariumId" TEXT DEFAULT 'global';
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "wins" INTEGER DEFAULT 0;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "losses" INTEGER DEFAULT 0;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "petBoostUntil" TIMESTAMP(3);
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "displayName" TEXT;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "bodyColor" TEXT;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "clawColor" TEXT;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "bandanaColor" TEXT;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "maxHp" INTEGER DEFAULT 100;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "attackDamage" INTEGER DEFAULT 10;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "friendshipChance" DOUBLE PRECISION DEFAULT 0.2;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "attackHitChance" DOUBLE PRECISION DEFAULT 0.8;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "critChance" DOUBLE PRECISION DEFAULT 0.05;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "pendingLevelUpLevel" INTEGER;
ALTER TABLE "Lobster" ADD COLUMN IF NOT EXISTS "feedCredits" INTEGER DEFAULT 0;

-- ─── 5. WIPE ALL DATA (clean slate for launch) ─────────────────────────────

DELETE FROM "FeedEvent";
DELETE FROM "PetEvent";
DELETE FROM "InstantRespawnEvent";
DELETE FROM "TankEvent";
DELETE FROM "NarratorPost";
DELETE FROM "TankSnapshot";
DELETE FROM "Lobster";
DELETE FROM "Community";
DELETE FROM "User";

-- ─── 6. SEED: Create the Global Tank ───────────────────────────────────────

INSERT INTO "Aquarium" ("id", "name", "maxLobsters", "createdAt", "updatedAt")
VALUES ('global', 'Global Tank', 120, NOW(), NOW())
ON CONFLICT ("id") DO UPDATE SET "maxLobsters" = 120, "updatedAt" = NOW();

-- ─── 7. PRISMA MIGRATIONS TABLE ────────────────────────────────────────────
-- This tells Prisma that all migrations have been applied, so it won't
-- try to re-run them and fail on "table already exists".

CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" VARCHAR(36) NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id")
);

INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "finished_at", "applied_steps_count")
VALUES
  (gen_random_uuid()::text, 'manual', '20260131140919_init', NOW(), 1),
  (gen_random_uuid()::text, 'manual', '20260130120000_add_lobster_display_name_and_colors', NOW(), 1),
  (gen_random_uuid()::text, 'manual', '20260130130000_add_lobster_bandana_color', NOW(), 1),
  (gen_random_uuid()::text, 'manual', '20260131164732_init', NOW(), 1),
  (gen_random_uuid()::text, 'manual', '20260131180000_add_pet_boost_until', NOW(), 1),
  (gen_random_uuid()::text, 'manual', '20260131200000_add_level_up_stats', NOW(), 1)
ON CONFLICT DO NOTHING;

COMMIT;

-- ============================================================================
-- DONE! Your database is ready for launch.
-- Tables created, data wiped, Global Tank seeded, Prisma migrations marked.
-- Deploy to Vercel and set your environment variables.
-- ============================================================================
