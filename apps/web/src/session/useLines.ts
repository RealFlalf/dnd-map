import { DEFAULT_LINE_TTL_MS, type ActionResult, type LineView, type Role } from '@dnd-map/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../socket';

/** A line as this page keeps it: when it goes, by this page's own clock. */
export interface LiveLine extends Omit<LineView, 'ttlMs'> {
  expiresAt: number;
  /** Drawn here and not confirmed by the server yet. */
  pending?: boolean;
}

const live = (line: LineView): LiveLine => {
  const { ttlMs, ...rest } = line;
  return { ...rest, expiresAt: Date.now() + ttlMs };
};

/**
 * Temporary lines over the map. They are not part of the versioned world: the server relays them
 * and forgets them, so here they are simply added as they come and dropped when their time is up.
 * `seed` is what the server had when we (re)joined; a new seed replaces everything.
 */
export function useLines(
  seed: { lines: LineView[]; nonce: number } | null,
  self: { id: string; role: Role } | null,
) {
  const [lines, setLines] = useState<LiveLine[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (seed) setLines(seed.lines.map(live));
  }, [seed]);

  useEffect(() => {
    const onDrawn = (line: LineView) =>
      setLines((list) => (list.some((l) => l.id === line.id) ? list : [...list, live(line)]));
    socket.on('line.drawn', onDrawn);
    return () => {
      socket.off('line.drawn', onDrawn);
    };
  }, []);

  // One timer, for whichever line goes first.
  useEffect(() => {
    clearTimeout(timer.current);
    if (lines.length === 0) return;
    const next = Math.min(...lines.map((l) => l.expiresAt));
    timer.current = setTimeout(
      () => setLines((list) => list.filter((l) => l.expiresAt > Date.now())),
      Math.max(0, next - Date.now()) + 20,
    );
    return () => clearTimeout(timer.current);
  }, [lines]);

  /** Shown at once; taken back if the server refuses it. */
  const draw = useCallback(
    async (mapId: string, points: number[]): Promise<ActionResult> => {
      if (!socket.connected || !self) return { ok: false, error: 'offline' };
      const localId = `local-${Date.now()}-${Math.random()}`;
      setLines((list) => [
        ...list,
        {
          id: localId,
          mapId,
          authorId: self.id,
          byMaster: self.role === 'master',
          points,
          expiresAt: Date.now() + DEFAULT_LINE_TTL_MS,
          pending: true,
        },
      ]);
      const drop = () => setLines((list) => list.filter((l) => l.id !== localId));
      try {
        const res = await socket.timeout(5000).emitWithAck('line.draw', { mapId, points });
        if (!res.ok) {
          drop();
          return res;
        }
        setLines((list) => list.map((l) => (l.id === localId ? live(res.line) : l)));
        return { ok: true };
      } catch {
        drop();
        return { ok: false, error: 'internal' };
      }
    },
    [self],
  );

  return { lines, draw };
}
