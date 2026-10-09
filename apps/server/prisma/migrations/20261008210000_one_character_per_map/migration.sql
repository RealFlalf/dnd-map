-- A race (one tap delivered twice on touch screens) could give a player two characters on one
-- map. Keep the oldest of each pair before the constraint makes it impossible.
DELETE FROM "tokens" AS t
USING "tokens" AS o
WHERE t."ownerParticipantId" IS NOT NULL
  AND t."mapId" = o."mapId"
  AND t."ownerParticipantId" = o."ownerParticipantId"
  AND (t."createdAt", t."id") > (o."createdAt", o."id");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_mapId_ownerParticipantId_key" ON "tokens"("mapId", "ownerParticipantId");
