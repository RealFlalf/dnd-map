import {
  ACCEPTED_IMAGE_TYPES,
  can,
  inviteCodeSchema,
  MAX_IMAGE_BYTES,
  type UploadError,
} from '@dnd-map/shared';
import type { FastifyInstance } from 'fastify';
import type { Realtime } from '../realtime';
import type { SessionService } from '../sessions/service';
import { ImageError, processImage } from './image';
import { TooManyMapsError, type MapService } from './service';
import { FILE_NAME_PATTERN, type FileStorage } from './storage';

interface Deps {
  sessions: SessionService;
  maps: MapService;
  storage: FileStorage;
  realtime: Realtime;
}

const STATUS_BY_ERROR: Record<UploadError, number> = {
  forbidden: 403,
  session_not_found: 404,
  empty_body: 400,
  invalid_image: 400,
  unsupported_format: 415,
  image_too_large: 413,
  too_many_maps: 409,
};

export function registerMapRoutes(app: FastifyInstance, deps: Deps): void {
  const { sessions, maps, storage, realtime } = deps;

  // The image is sent as the raw request body (Content-Type: image/*), so no multipart parser is needed.
  // Registered in its own scope so the large body limit applies to this route only.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      [...ACCEPTED_IMAGE_TYPES],
      { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
      (_req, body, done) => done(null, body),
    );

    scope.post<{ Params: { inviteCode: string } }>(
      '/api/sessions/:inviteCode/maps',
      async (req, reply) => {
        const fail = (error: UploadError) => reply.code(STATUS_BY_ERROR[error]).send({ error });

        const code = inviteCodeSchema.safeParse(req.params.inviteCode);
        const session = code.success ? await sessions.findByInviteCode(code.data) : null;
        if (!session) return fail('session_not_found');

        const key = req.headers['x-participant-key'];
        const participant =
          typeof key === 'string' ? await sessions.findParticipantByKey(session.id, key) : null;
        if (
          !participant ||
          !can({ participantId: participant.id, role: participant.role }, 'map.set')
        ) {
          return fail('forbidden');
        }

        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) return fail('empty_body');

        try {
          const image = await processImage(body);
          const mapId = await maps.addMap(session.id, body, image);
          await realtime.broadcastState(session.id);
          return reply.code(201).send({ mapId });
        } catch (err) {
          if (err instanceof ImageError) return fail(err.code);
          if (err instanceof TooManyMapsError) return fail('too_many_maps');
          throw err;
        }
      },
    );
  });

  // File names are random UUIDs, so a link is only known to session members (capability URL).
  app.get<{ Params: { name: string } }>('/api/files/:name', async (req, reply) => {
    const { name } = req.params;
    const file = FILE_NAME_PATTERN.test(name) ? await storage.open(name) : null;
    if (!file) return reply.code(404).send({ error: 'not_found' });

    return reply
      .header('Content-Type', file.contentType)
      .header('Content-Length', file.size)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.stream);
  });
}
