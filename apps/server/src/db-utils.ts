import type { GridSettings } from '@dnd-map/shared';
import type { Map as MapRow, Prisma } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

/** Every state change bumps the session version in the same transaction as the change itself. */
export function bumpVersion(
  tx: Tx,
  sessionId: string,
  data: Prisma.SessionUncheckedUpdateInput = {},
) {
  return tx.session.update({
    where: { id: sessionId },
    data: { ...data, version: { increment: 1 }, lastActivityAt: new Date() },
    select: { version: true },
  });
}

/** Append-only audit trail (who did what); kept in the same transaction as the change. */
export function logEvent(
  tx: Tx,
  sessionId: string,
  participantId: string,
  type: string,
  payload: Prisma.InputJsonValue,
) {
  return tx.eventLog.create({ data: { sessionId, participantId, type, payload } });
}

export function gridOf(m: MapRow): GridSettings {
  return {
    scale: m.gridScale,
    offsetX: m.gridOffsetX,
    offsetY: m.gridOffsetY,
    visible: m.gridVisible,
    snap: m.gridSnap,
  };
}
