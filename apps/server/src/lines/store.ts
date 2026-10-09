import { randomUUID } from 'node:crypto';
import { MAX_LINES_PER_PARTICIPANT, type LineView } from '@dnd-map/shared';

interface StoredLine {
  line: Omit<LineView, 'ttlMs'>;
  expiresAt: number;
}

export interface LineStore {
  /** Keeps a new line until it expires; null if its author already has too many on the map. */
  add(sessionId: string, line: Omit<LineView, 'id' | 'ttlMs'>): LineView | null;
  /** Lines still alive on a map, with the time each has left. */
  active(sessionId: string, mapId: string): LineView[];
}

/**
 * Temporary lines live only in memory (one server, see §12 of the architecture): they are not
 * worth a database row and are gone after `ttlMs` anyway. Expired lines are dropped lazily on
 * every read and write, so nothing needs a timer.
 */
export function createLineStore(ttlMs: number, now: () => number = Date.now): LineStore {
  const bySession = new Map<string, StoredLine[]>();

  const alive = (sessionId: string): StoredLine[] => {
    const t = now();
    const lines = (bySession.get(sessionId) ?? []).filter((s) => s.expiresAt > t);
    if (lines.length > 0) bySession.set(sessionId, lines);
    else bySession.delete(sessionId);
    return lines;
  };
  const view = (s: StoredLine): LineView => ({ ...s.line, ttlMs: s.expiresAt - now() });

  return {
    add(sessionId, line) {
      // Sweep the other sessions too: one that went quiet would otherwise keep its lines forever.
      for (const other of [...bySession.keys()]) if (other !== sessionId) alive(other);
      const lines = alive(sessionId);
      const own = lines.filter(
        (s) => s.line.authorId === line.authorId && s.line.mapId === line.mapId,
      );
      if (own.length >= MAX_LINES_PER_PARTICIPANT) return null;
      const stored: StoredLine = { line: { id: randomUUID(), ...line }, expiresAt: now() + ttlMs };
      bySession.set(sessionId, [...lines, stored]);
      return view(stored);
    },

    active(sessionId, mapId) {
      return alive(sessionId)
        .filter((s) => s.line.mapId === mapId)
        .map(view);
    },
  };
}
