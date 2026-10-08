-- CreateEnum
CREATE TYPE "Role" AS ENUM ('master', 'player');

-- CreateEnum
CREATE TYPE "TokenType" AS ENUM ('monster', 'player_character');

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "masterKeyHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "currentMapId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participants" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "displayName" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maps" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "previewUrl" TEXT,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "gridScale" DOUBLE PRECISION NOT NULL DEFAULT 70,
    "gridOffsetX" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gridOffsetY" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gridVisible" BOOLEAN NOT NULL DEFAULT true,
    "gridSnap" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "type" "TokenType" NOT NULL,
    "ownerParticipantId" TEXT,
    "name" TEXT NOT NULL,
    "iconUrl" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 1,
    "visibleToPlayers" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_log" (
    "id" BIGSERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "participantId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_inviteCode_key" ON "sessions"("inviteCode");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_currentMapId_key" ON "sessions"("currentMapId");

-- CreateIndex
CREATE INDEX "sessions_lastActivityAt_idx" ON "sessions"("lastActivityAt");

-- CreateIndex
CREATE UNIQUE INDEX "participants_sessionId_keyHash_key" ON "participants"("sessionId", "keyHash");

-- CreateIndex
CREATE INDEX "maps_sessionId_idx" ON "maps"("sessionId");

-- CreateIndex
CREATE INDEX "tokens_mapId_idx" ON "tokens"("mapId");

-- CreateIndex
CREATE INDEX "event_log_sessionId_createdAt_idx" ON "event_log"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_currentMapId_fkey" FOREIGN KEY ("currentMapId") REFERENCES "maps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participants" ADD CONSTRAINT "participants_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maps" ADD CONSTRAINT "maps_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "maps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_ownerParticipantId_fkey" FOREIGN KEY ("ownerParticipantId") REFERENCES "participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
