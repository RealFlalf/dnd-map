/**
 * Load test: many sessions playing at once against a running server.
 *
 *   pnpm --filter @dnd-map/server load-test            (defaults below)
 *   LOAD_URL=http://host:3000 LOAD_SESSIONS=20 LOAD_PLAYERS=9 LOAD_SECONDS=60 pnpm ... load-test
 *
 * Every session has a master and LOAD_PLAYERS players. The master drags a monster continuously
 * (live positions, ~20/s) and drops one every second; every player moves their character every
 * two seconds. For each drop the script measures when every *other* participant of the session
 * sees the token at its new place (requirement NFR-01: within 200-300 ms).
 *
 * All clients come from one address, so run the server with RATE_LIMIT=off for this test.
 * The clients share one Node process with the measurement; on a weak machine they can become the
 * bottleneck themselves, which shows up as high latency for every session at once.
 */
import type {
  ClientToServerEvents,
  CreateSessionResponse,
  JoinResult,
  ServerToClientEvents,
  TokenResult,
  TokensPatch,
} from '@dnd-map/shared';
import sharp from 'sharp';
import { io, type Socket } from 'socket.io-client';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const BASE = process.env.LOAD_URL ?? 'http://127.0.0.1:3000';
const SESSIONS = Number(process.env.LOAD_SESSIONS ?? 20);
const PLAYERS = Number(process.env.LOAD_PLAYERS ?? 9);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 60);
const MONSTERS = 10;
const CELL = 70;
const COLS = 20;
const ROWS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cellCentre = (i: number) => ({
  x: (i % COLS) * CELL + CELL / 2,
  y: (Math.floor(i / COLS) % ROWS) * CELL + CELL / 2,
});

interface Pending {
  sentAt: number;
  expected: number;
  received: number;
}
const pending = new Map<string, Pending>();
const latencies: number[] = [];
const ackLatencies: number[] = [];
const errors = new Map<string, number>();
let moves = 0;
let drags = 0;
const countError = (e: string) => errors.set(e, (errors.get(e) ?? 0) + 1);

function connect(): Promise<Client> {
  const socket: Client = io(BASE, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

/** Every receiver reports what it sees; a drop counts as delivered when the position matches. */
function listen(socket: Client) {
  socket.on('tokens.changed', (patch: TokensPatch) => {
    const now = performance.now();
    for (const t of patch.upserted) {
      const p = pending.get(`${t.id}:${t.x}:${t.y}`);
      if (!p) continue;
      p.received++;
      latencies.push(now - p.sentAt);
    }
  });
}

async function join(inviteCode: string, request: { key: string } | { displayName: string }) {
  const socket = await connect();
  const res: JoinResult = await socket
    .timeout(10_000)
    .emitWithAck('session.join', { inviteCode, ...request });
  if (!res.ok) throw new Error(`join failed: ${res.error}`);
  listen(socket);
  return { socket, res };
}

async function move(
  socket: Client,
  tokenId: string,
  to: { x: number; y: number },
  receivers: number,
) {
  const key = `${tokenId}:${to.x}:${to.y}`;
  const sentAt = performance.now();
  pending.set(key, { sentAt, expected: receivers, received: 0 });
  moves++;
  try {
    const res: TokenResult = await socket
      .timeout(10_000)
      .emitWithAck('token.move', { tokenId, ...to });
    ackLatencies.push(performance.now() - sentAt);
    if (!res.ok) {
      countError(res.error);
      pending.delete(key);
    }
  } catch {
    countError('ack timeout');
  }
}

async function setUpSession(index: number, map: Buffer) {
  const created = (await (
    await fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: `Мастер ${index}` }),
    })
  ).json()) as CreateSessionResponse;
  const upload = await fetch(`${BASE}/api/sessions/${created.inviteCode}/maps`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-participant-key': created.participantKey },
    body: map,
  });
  if (upload.status !== 201) throw new Error(`upload failed: ${upload.status}`);

  const master = await join(created.inviteCode, { key: created.participantKey });
  const mapId = master.res.state.currentMapId!;
  const monsters: string[] = [];
  for (let i = 0; i < MONSTERS; i++) {
    const res: TokenResult = await master.socket
      .timeout(10_000)
      .emitWithAck('token.create', { mapId, icon: 'goblin', ...cellCentre(i * 3) });
    if (!res.ok) throw new Error(`token.create failed: ${res.error}`);
    monsters.push(res.token.id);
  }

  const players = [];
  for (let p = 0; p < PLAYERS; p++) {
    const player = await join(created.inviteCode, { displayName: `Игрок ${index}.${p}` });
    const res: TokenResult = await player.socket
      .timeout(10_000)
      .emitWithAck('character.place', { mapId, ...cellCentre(100 + p * 2) });
    if (!res.ok) throw new Error(`character.place failed: ${res.error}`);
    players.push({ socket: player.socket, tokenId: res.token.id });
  }
  return { master: master.socket, monsters, players };
}

function percentile(sorted: number[], p: number) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : NaN;
}

async function main() {
  console.log(
    `load test: ${SESSIONS} sessions x (1 master + ${PLAYERS} players) for ${SECONDS} s against ${BASE}`,
  );
  const map = await sharp({
    create: { width: COLS * CELL, height: ROWS * CELL, channels: 3, background: '#d9c9a3' },
  })
    .png()
    .toBuffer();

  const t0 = performance.now();
  const sessions = [];
  for (let i = 0; i < SESSIONS; i++) sessions.push(await setUpSession(i, map));
  const participants = SESSIONS * (PLAYERS + 1);
  console.log(
    `set up ${SESSIONS} sessions, ${participants} connections in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );

  const receivers = PLAYERS; // everyone in the session except the one who moves
  const stopAt = performance.now() + SECONDS * 1000;
  const loops: Promise<void>[] = [];

  sessions.forEach((s, si) => {
    // Master: drag continuously, drop once a second (offset per session so they do not all fire together).
    loops.push(
      (async () => {
        await sleep((si * 1000) / SESSIONS);
        let step = 0;
        while (performance.now() < stopAt) {
          const tokenId = s.monsters[step % MONSTERS]!;
          const dragsPerDrop = Number(process.env.LOAD_DRAGS_PER_DROP ?? 20);
          for (let d = 0; d < dragsPerDrop && performance.now() < stopAt; d++) {
            s.master.volatile.emit('token.drag', { tokenId, x: 100 + d * 5, y: 100 });
            drags++;
            await sleep(50);
          }
          if (dragsPerDrop === 0) await sleep(1000);
          await move(s.master, tokenId, cellCentre(step * 7 + si), receivers);
          step++;
        }
      })(),
    );
    // Players: one move every two seconds each, spread out.
    s.players.forEach((p, pi) =>
      loops.push(
        (async () => {
          await sleep(((si * PLAYERS + pi) * 2000) / (SESSIONS * PLAYERS));
          let step = 0;
          while (performance.now() < stopAt) {
            await move(p.socket, p.tokenId, cellCentre(120 + ((step * 3 + pi) % 60)), receivers);
            step++;
            await sleep(2000);
          }
        })(),
      ),
    );
  });

  const metricsDuring = (async () => {
    await sleep((SECONDS * 1000) / 2);
    return (await fetch(`${BASE}/api/metrics`)).json() as Promise<Record<string, number>>;
  })();
  await Promise.all(loops);
  await sleep(2000); // let the last deliveries arrive

  let lost = 0;
  for (const p of pending.values()) lost += p.expected - p.received;
  const sorted = [...latencies].sort((a, b) => a - b);
  const acks = [...ackLatencies].sort((a, b) => a - b);
  const delivered = latencies.length;
  const over300 = latencies.filter((l) => l > 300).length;

  console.log(
    `\nmoves sent: ${moves} (${(moves / SECONDS).toFixed(1)}/s), live drag messages: ${drags} (${(drags / SECONDS).toFixed(0)}/s)`,
  );
  console.log(`deliveries to other participants: ${delivered}, lost: ${lost}`);
  console.log(
    `delivery latency ms: p50 ${percentile(sorted, 0.5).toFixed(1)}, p95 ${percentile(sorted, 0.95).toFixed(1)}, ` +
      `p99 ${percentile(sorted, 0.99).toFixed(1)}, max ${sorted.at(-1)?.toFixed(1)}; over 300 ms: ${over300} (${((over300 / Math.max(1, delivered)) * 100).toFixed(2)}%)`,
  );
  console.log(
    `ack latency ms (sender): p50 ${percentile(acks, 0.5).toFixed(1)}, p95 ${percentile(acks, 0.95).toFixed(1)}, max ${acks.at(-1)?.toFixed(1)}`,
  );
  console.log(`errors: ${errors.size ? JSON.stringify(Object.fromEntries(errors)) : 'none'}`);
  console.log(`server metrics half-way: ${JSON.stringify(await metricsDuring)}`);

  for (const s of sessions) {
    s.master.close();
    for (const p of s.players) p.socket.close();
  }
  const ok = lost === 0 && errors.size === 0 && percentile(sorted, 0.95) < 300;
  console.log(ok ? '\nRESULT: OK (p95 < 300 ms, nothing lost, no errors)' : '\nRESULT: NOT OK');
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
