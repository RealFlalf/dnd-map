import {
  can,
  FILES_URL_PREFIX,
  inviteCodeSchema,
  MAX_ICON_BYTES,
  type UploadError,
} from '@dnd-map/shared';
import { ACCEPTED_IMAGE_TYPES } from '@dnd-map/shared';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ImageError, processIcon } from '../maps/image';
import type { FileStorage } from '../maps/storage';
import type { Realtime } from '../realtime';
import type { SessionService } from '../sessions/service';
import type { CharacterService } from './service';

interface Deps {
  sessions: SessionService;
  characters: CharacterService;
  storage: FileStorage;
  realtime: Realtime;
}

type IconError = Extract<
  UploadError,
  | 'forbidden'
  | 'session_not_found'
  | 'empty_body'
  | 'invalid_image'
  | 'unsupported_format'
  | 'image_too_large'
>;

const STATUS: Record<IconError, number> = {
  forbidden: 403,
  session_not_found: 404,
  empty_body: 400,
  invalid_image: 400,
  unsupported_format: 415,
  image_too_large: 413,
};

export function registerCharacterRoutes(app: FastifyInstance, deps: Deps): void {
  const { sessions, characters, storage, realtime } = deps;

  // Own scope, so the 2 MB body limit applies to this route only.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      [...ACCEPTED_IMAGE_TYPES],
      { parseAs: 'buffer', bodyLimit: MAX_ICON_BYTES },
      (_req, body, done) => done(null, body),
    );

    scope.post<{ Params: { inviteCode: string } }>(
      '/api/sessions/:inviteCode/icon',
      async (req, reply) => {
        const fail = (error: IconError) => reply.code(STATUS[error]).send({ error });

        const code = inviteCodeSchema.safeParse(req.params.inviteCode);
        const session = code.success ? await sessions.findByInviteCode(code.data) : null;
        if (!session) return fail('session_not_found');

        const key = req.headers['x-participant-key'];
        const participant =
          typeof key === 'string' ? await sessions.findParticipantByKey(session.id, key) : null;
        if (
          !participant ||
          !can({ participantId: participant.id, role: participant.role }, 'character.setIcon')
        ) {
          return fail('forbidden');
        }

        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) return fail('empty_body');

        const name = `${randomUUID()}.icon.webp`;
        try {
          await storage.save(name, await processIcon(body));
        } catch (err) {
          if (err instanceof ImageError) return fail(err.code);
          throw err;
        }

        try {
          const result = await characters.setIcon(
            session.id,
            participant.id,
            FILES_URL_PREFIX + name,
          );
          await realtime.announceCharacter(session.id, result.change);
          return reply.code(201).send({ icon: result.icon });
        } catch (err) {
          await storage.remove(name).catch(() => undefined);
          throw err;
        }
      },
    );
  });
}
