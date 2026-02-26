-- =============================================================================
-- LOBSTER TANK – ONE SCRIPT: WIPE PUBLIC SCHEMA THEN CREATE ALL TABLES
-- Paste this ENTIRE file into Supabase SQL Editor and click Run once.
-- =============================================================================

-- STEP 1: DELETE EVERYTHING IN PUBLIC SCHEMA
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres, public;

-- STEP 2: CREATE ALL TABLES
CREATE TABLE "User" (
  "id"            TEXT        NOT NULL,
  "twitterId"     TEXT,
  "handle"        TEXT,
  "avatar"        TEXT,
  "walletAddress" TEXT,
  "passwordHash"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Aquarium" (
  "id"          TEXT         NOT NULL,
  "name"        TEXT         NOT NULL,
  "maxLobsters" INTEGER      NOT NULL DEFAULT 120,
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Aquarium_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Community" (
  "id"          TEXT         NOT NULL,
  "name"        TEXT         NOT NULL,
  "color"       TEXT         NOT NULL,
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Community_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Lobster" (
  "id"               TEXT         NOT NULL,
  "ownerUserId"      TEXT         NOT NULL,
  "aquariumId"       TEXT         NOT NULL DEFAULT 'global',
  "level"            INTEGER      NOT NULL DEFAULT 1,
  "xp"               INTEGER      NOT NULL DEFAULT 0,
  "size"             DOUBLE PRECISION NOT NULL DEFAULT 1,
  "wins"             INTEGER      NOT NULL DEFAULT 0,
  "losses"           INTEGER      NOT NULL DEFAULT 0,
  "traits"           JSONB,
  "status"           TEXT         NOT NULL DEFAULT 'Neutral',
  "communityId"      TEXT,
  "leftCommunityAt"  TIMESTAMP(3),
  "lastFed"          TIMESTAMP(3),
  "lastPet"          TIMESTAMP(3),
  "petBoostUntil"    TIMESTAMP(3),
  "displayName"      TEXT,
  "bodyColor"        TEXT,
  "clawColor"        TEXT,
  "bandanaColor"     TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Lobster_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeedEvent" (
  "id"        TEXT         NOT NULL,
  "userId"    TEXT         NOT NULL,
  "lobsterId" TEXT         NOT NULL,
  "txHash"    TEXT         NOT NULL,
  "amount"    DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeedEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PetEvent" (
  "id"        TEXT         NOT NULL,
  "userId"    TEXT         NOT NULL,
  "lobsterId" TEXT         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PetEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TankEvent" (
  "id"        TEXT         NOT NULL,
  "type"      TEXT         NOT NULL,
  "payload"   JSONB        NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TankEvent_pkey" PRIMARY KEY ("id")
);

-- STEP 3: UNIQUE CONSTRAINTS (creates index + constraint)
ALTER TABLE "User" ADD CONSTRAINT "User_twitterId_key" UNIQUE ("twitterId");
ALTER TABLE "FeedEvent" ADD CONSTRAINT "FeedEvent_txHash_key" UNIQUE ("txHash");

-- STEP 4: FOREIGN KEYS
ALTER TABLE "Lobster" ADD CONSTRAINT "Lobster_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Lobster" ADD CONSTRAINT "Lobster_aquariumId_fkey"
  FOREIGN KEY ("aquariumId") REFERENCES "Aquarium" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Lobster" ADD CONSTRAINT "Lobster_communityId_fkey"
  FOREIGN KEY ("communityId") REFERENCES "Community" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FeedEvent" ADD CONSTRAINT "FeedEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FeedEvent" ADD CONSTRAINT "FeedEvent_lobsterId_fkey"
  FOREIGN KEY ("lobsterId") REFERENCES "Lobster" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PetEvent" ADD CONSTRAINT "PetEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PetEvent" ADD CONSTRAINT "PetEvent_lobsterId_fkey"
  FOREIGN KEY ("lobsterId") REFERENCES "Lobster" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
