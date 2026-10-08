import type { CreateSessionResponse } from '@dnd-map/shared';
import { Prisma, type Participant, type PrismaClient } from '@prisma/client';
import { generateInviteCode, generateParticipantKey, hashParticipantKey } from './secrets';

const INVITE_CODE_ATTEMPTS = 5;

export type SessionService = ReturnType<typeof createSessionService>;

export function createSessionService(prisma: PrismaClient) {
  return {
    /** Creates a session together with its master. The creator is the only master (no role transfer in MVP). */
    async create(displayName: string): Promise<CreateSessionResponse> {
      const participantKey = generateParticipantKey();
      const keyHash = hashParticipantKey(participantKey);

      for (let attempt = 0; attempt < INVITE_CODE_ATTEMPTS; attempt++) {
        try {
          const session = await prisma.session.create({
            data: {
              inviteCode: generateInviteCode(),
              masterKeyHash: keyHash,
              participants: { create: { role: 'master', displayName, keyHash } },
            },
          });
          return { inviteCode: session.inviteCode, participantKey };
        } catch (err) {
          if (isUniqueViolation(err)) continue; // invite code collision, try another one
          throw err;
        }
      }
      throw new Error('Could not allocate a unique invite code');
    },

    findByInviteCode(inviteCode: string) {
      return prisma.session.findUnique({
        where: { inviteCode },
        select: { id: true, inviteCode: true },
      });
    },

    findParticipantByKey(sessionId: string, key: string): Promise<Participant | null> {
      return prisma.participant.findUnique({
        where: { sessionId_keyHash: { sessionId, keyHash: hashParticipantKey(key) } },
      });
    },

    /** New participants joining by invite are always players. */
    async addPlayer(sessionId: string, displayName: string) {
      const participantKey = generateParticipantKey();
      const participant = await prisma.participant.create({
        data: {
          sessionId,
          role: 'player',
          displayName,
          keyHash: hashParticipantKey(participantKey),
        },
      });
      return { participant, participantKey };
    },

    listParticipants(sessionId: string): Promise<Participant[]> {
      return prisma.participant.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
    },

    async touch(sessionId: string, participantId: string): Promise<void> {
      const now = new Date();
      await prisma.$transaction([
        prisma.participant.update({ where: { id: participantId }, data: { lastSeenAt: now } }),
        prisma.session.update({ where: { id: sessionId }, data: { lastActivityAt: now } }),
      ]);
    },
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
