import { FILES_URL_PREFIX } from '@dnd-map/shared';
import type { PrismaClient } from '@prisma/client';
import { bumpVersion, logEvent } from '../db-utils';
import type { FileStorage } from '../maps/storage';
import type { TokenChange } from '../tokens/patch';
import { toTokenView } from '../tokens/view';

export type CharacterService = ReturnType<typeof createCharacterService>;

export function createCharacterService(prisma: PrismaClient, storage: FileStorage) {
  return {
    /**
     * Stores the participant's new icon and applies it to every token they own. If their token is
     * on the current map the change is returned so it can be announced; tokens on other maps
     * just pick the icon up silently and show it when their map is opened again.
     */
    async setIcon(
      sessionId: string,
      participantId: string,
      icon: string,
    ): Promise<{ icon: string; change: TokenChange | null }> {
      const { previous, change } = await prisma.$transaction(async (tx) => {
        const participant = await tx.participant.findFirstOrThrow({
          where: { id: participantId, sessionId },
        });
        await tx.participant.update({ where: { id: participantId }, data: { iconUrl: icon } });
        await tx.token.updateMany({
          where: { ownerParticipantId: participantId },
          data: { iconUrl: icon },
        });

        const session = await tx.session.findUniqueOrThrow({
          where: { id: sessionId },
          select: { currentMapId: true },
        });
        const shown = session.currentMapId
          ? await tx.token.findFirst({
              where: { ownerParticipantId: participantId, mapId: session.currentMapId },
            })
          : null;
        await logEvent(tx, sessionId, participantId, 'character.icon', { icon });

        if (!shown) return { previous: participant.iconUrl, change: null };
        const { version } = await bumpVersion(tx, sessionId);
        return {
          previous: participant.iconUrl,
          change: { version, token: toTokenView(shown), wasVisible: true, removed: false },
        };
      });

      // The replaced upload is no longer referenced by anything; a failure here only leaves a stray file.
      if (previous?.startsWith(FILES_URL_PREFIX) && previous !== icon) {
        await storage.remove(previous.slice(FILES_URL_PREFIX.length)).catch(() => undefined);
      }
      return { icon, change };
    },
  };
}
