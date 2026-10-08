import { createSessionRequestSchema, inviteCodeSchema } from '@dnd-map/shared';
import type { FastifyInstance } from 'fastify';
import type { SessionService } from './service';

export function registerSessionRoutes(app: FastifyInstance, sessions: SessionService): void {
  app.post('/api/sessions', async (req, reply) => {
    const body = createSessionRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

    const created = await sessions.create(body.data.displayName);
    return reply.code(201).send(created);
  });

  // Lets the join page tell "no such session" apart from "need your name" before connecting.
  app.get<{ Params: { inviteCode: string } }>('/api/sessions/:inviteCode', async (req, reply) => {
    const code = inviteCodeSchema.safeParse(req.params.inviteCode);
    const session = code.success ? await sessions.findByInviteCode(code.data) : null;
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    return { inviteCode: session.inviteCode };
  });
}
