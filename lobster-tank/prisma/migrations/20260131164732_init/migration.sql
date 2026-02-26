-- AlterTable
ALTER TABLE "Lobster" ADD COLUMN     "aquariumId" TEXT NOT NULL DEFAULT 'global';

-- CreateTable
CREATE TABLE "Aquarium" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxLobsters" INTEGER NOT NULL DEFAULT 120,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Aquarium_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Lobster" ADD CONSTRAINT "Lobster_aquariumId_fkey" FOREIGN KEY ("aquariumId") REFERENCES "Aquarium"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
