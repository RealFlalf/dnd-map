import type { TokenView } from '@dnd-map/shared';
import { describe, expect, it } from 'vitest';
import { patchFor, type TokenChange } from './patch';

const token = (visible: boolean): TokenView => ({
  id: 't1',
  mapId: 'm1',
  type: 'monster',
  ownerParticipantId: null,
  name: 'Волк 1',
  icon: 'builtin:wolf',
  x: 105,
  y: 105,
  size: 1,
  visible,
});

const change = (over: Partial<TokenChange> & { visible: boolean }): TokenChange => ({
  version: 7,
  token: token(over.visible),
  previous: null,
  wasVisible: over.visible,
  removed: false,
  ...over,
});

const empty = { version: 7, upserted: [], removedIds: [] };

describe('patchFor', () => {
  it('shows a visible token to everyone', () => {
    const c = change({ visible: true });
    expect(patchFor(c, 'master')).toEqual({ version: 7, upserted: [c.token], removedIds: [] });
    expect(patchFor(c, 'player')).toEqual({ version: 7, upserted: [c.token], removedIds: [] });
  });

  it('tells players nothing about a hidden token, but keeps their version moving', () => {
    const c = change({ visible: false });
    expect(patchFor(c, 'master').upserted).toEqual([c.token]);
    expect(patchFor(c, 'player')).toEqual(empty);
  });

  it('removes a token from players when it gets hidden, and adds it when it is revealed', () => {
    const hidden = change({ visible: false, wasVisible: true });
    expect(patchFor(hidden, 'player')).toEqual({ version: 7, upserted: [], removedIds: ['t1'] });
    expect(patchFor(hidden, 'master').upserted).toHaveLength(1);

    const revealed = change({ visible: true, wasVisible: false });
    expect(patchFor(revealed, 'player').upserted).toEqual([revealed.token]);
  });

  it('announces a deletion to those who could see the token only', () => {
    const visible = change({ visible: true, removed: true });
    expect(patchFor(visible, 'master')).toEqual({ version: 7, upserted: [], removedIds: ['t1'] });
    expect(patchFor(visible, 'player')).toEqual({ version: 7, upserted: [], removedIds: ['t1'] });

    const hidden = change({ visible: false, wasVisible: false, removed: true });
    expect(patchFor(hidden, 'master').removedIds).toEqual(['t1']);
    expect(patchFor(hidden, 'player')).toEqual(empty);
  });

  describe('with fog of war', () => {
    const moved = change({ visible: true, previous: token(true) });

    it('shows a monster to players when it comes into view, and hides it when it leaves', () => {
      expect(patchFor(moved, 'player', { before: false, now: true })).toEqual({
        version: 7,
        upserted: [moved.token],
        removedIds: [],
      });
      expect(patchFor(moved, 'player', { before: true, now: false })).toEqual({
        version: 7,
        upserted: [],
        removedIds: ['t1'],
      });
    });

    it('says nothing to players about a monster that stays out of sight, but keeps their version moving', () => {
      expect(patchFor(moved, 'player', { before: false, now: false })).toEqual(empty);
    });

    it('updates a monster that stays in view, as without fog', () => {
      expect(patchFor(moved, 'player', { before: true, now: true }).upserted).toEqual([
        moved.token,
      ]);
    });

    it('does not let fog change what the master hears', () => {
      expect(patchFor(moved, 'master', { before: false, now: false }).upserted).toEqual([
        moved.token,
      ]);
      const gone = change({ visible: true, removed: true });
      expect(patchFor(gone, 'master', { before: false, now: false }).removedIds).toEqual(['t1']);
    });

    it('trusts the fog answer over the hidden flag only to narrow, never to widen: callers pass both', () => {
      // a visible-flagged monster out of sight is not sent; the caller never passes now=true for a hidden one
      expect(patchFor(change({ visible: false }), 'player', { before: false, now: false })).toEqual(
        empty,
      );
    });
  });
});
