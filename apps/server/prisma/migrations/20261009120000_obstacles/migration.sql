-- CreateEnum
CREATE TYPE "ObstacleKind" AS ENUM ('wall', 'pillar', 'barrel');

-- CreateTable
CREATE TABLE "obstacles" (
    "id" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "kind" "ObstacleKind" NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "blocksMovement" BOOLEAN NOT NULL DEFAULT true,
    "blocksSight" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "obstacles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "obstacles_mapId_idx" ON "obstacles"("mapId");

-- AddForeignKey
ALTER TABLE "obstacles" ADD CONSTRAINT "obstacles_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "maps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

