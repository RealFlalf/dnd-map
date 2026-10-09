import { MAX_LINES_PER_PARTICIPANT } from '@dnd-map/shared';
import { describe, expect, it } from 'vitest';
import { createLineStore } from './store';

const clock = () => {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};
const line = (authorId = 'p1', mapId = 'm1') => ({
  mapId,
  authorId,
  byMaster: false,
  points: [0, 0, 10, 10],
});

describe('line store', () => {
  it('keeps a line for its lifetime and tells how much of it is left', () => {
    const c = clock();
    const store = createLineStore(30_000, c.now);
    const added = store.add('s1', line())!;
    expect(added.ttlMs).toBe(30_000);
    c.advance(10_000);
    expect(store.active('s1', 'm1')).toEqual([{ ...added, ttlMs: 20_000 }]);
    c.advance(20_000);
    expect(store.active('s1', 'm1')).toEqual([]);
  });

  it('keeps maps and sessions apart', () => {
    const store = createLineStore(30_000, clock().now);
    store.add('s1', line('p1', 'm1'));
    store.add('s1', line('p1', 'm2'));
    store.add('s2', line('p1', 'm1'));
    expect(store.active('s1', 'm1')).toHaveLength(1);
    expect(store.active('s1', 'm2')).toHaveLength(1);
    expect(store.active('s2', 'm2')).toHaveLength(0);
  });

  it('limits the lines of one participant on one map, until some fade', () => {
    const c = clock();
    const store = createLineStore(30_000, c.now);
    for (let i = 0; i < MAX_LINES_PER_PARTICIPANT; i++) {
      expect(store.add('s1', line('p1'))).not.toBeNull();
      c.advance(100);
    }
    expect(store.add('s1', line('p1'))).toBeNull();
    expect(store.add('s1', line('p2'))).not.toBeNull(); // somebody else still can
    expect(store.add('s1', line('p1', 'm2'))).not.toBeNull(); // and on another map too
    c.advance(30_000 - MAX_LINES_PER_PARTICIPANT * 100 + 1); // the first one has faded
    expect(store.add('s1', line('p1'))).not.toBeNull();
  });

  it('gives every line its own id', () => {
    const store = createLineStore(30_000, clock().now);
    expect(store.add('s1', line())!.id).not.toBe(store.add('s1', line())!.id);
  });
});
