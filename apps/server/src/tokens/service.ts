import {
  BUILTIN_ICON_PREFIX,
  defaultCharacterIcon,
  MAX_TOKENS_PER_MAP,
  MONSTER_ICONS,
  placeToken,
  type CharacterPlace,
  type Point,
  type TokenCreate,
  type TokenView,
} from '@dnd-map/shared';
import { Prisma, type Map as MapRow, type PrismaClient, type Token } from '@prisma/client';
import { bumpVersion, gridOf, logEvent, type Tx } from '../db-utils';
import type { TokenChange } from './patch';
import { toTokenView } from './view';

type Failure =
  | 'token_not_found'
  | 'participant_not_found'
  | 'map_not_found'
  | 'forbidden'
  | 'too_many_tokens'
  | 'already_placed';
export type TokenOutcome = { ok: true; change: TokenChange } | { ok: false; error: Failure };

/** Decides inside the transaction whether the actor may touch the token (it is loaded fresh). */
export type Guard = (token: TokenView) => boolean;

export type TokenService = ReturnType<typeof createTokenService>;

const fail = (error: Failure): TokenOutcome => ({ ok: false, error });

export function createTokenService(prisma: PrismaClient) {
  const mapBox = (m: MapRow) => ({ width: m.width, height: m.height, grid: gridOf(m) });

  /** Tokens are only reachable while their map is the session's current one. */
  async function load(tx: Tx, sessionId: string, tokenId: string) {
    const row = await tx.token.findFirst({
      where: { id: tokenId, map: { sessionId } },
      include: { map: true },
    });
    if (!row) return null;
    const session = await tx.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { currentMapId: true },
    });
    return session.currentMapId === row.mapId ? row : null;
  }

  const changeOf = (
    version: number,
    row: Token,
    wasVisible: boolean,
    removed = false,
  ): TokenOutcome => ({
    ok: true,
    change: { version, token: toTokenView(row), wasVisible, removed },
  });

  return {
    /** For relaying drags: the token as it is now, or null if it does not exist on the current map. */
    async find(sessionId: string, tokenId: string): Promise<TokenView | null> {
      const row = await prisma.$transaction((tx) => load(tx, sessionId, tokenId));
      return row && toTokenView(row);
    },

    /** Places a monster on the current map. Position is snapped and clamped like a move. */
    async create(
      sessionId: string,
      participantId: string,
      req: TokenCreate,
    ): Promise<TokenOutcome> {
      return prisma.$transaction(async (tx) => {
        const session = await tx.session.findUniqueOrThrow({
          where: { id: sessionId },
          select: { currentMapId: true },
        });
        if (session.currentMapId !== req.mapId) return fail('map_not_found');
        const map = await tx.map.findUniqueOrThrow({ where: { id: req.mapId } });

        const iconUrl = BUILTIN_ICON_PREFIX + req.icon;
        const existing = await tx.token.findMany({
          where: { mapId: map.id },
          select: { name: true, iconUrl: true },
        });
        if (existing.length >= MAX_TOKENS_PER_MAP) return fail('too_many_tokens');

        // "Волк 1", "Волк 2", ...: the next number after the highest one in use, so names stay unique.
        const label = MONSTER_ICONS.find((i) => i.id === req.icon)?.label ?? 'Моб';
        const highest = existing
          .filter((t) => t.iconUrl === iconUrl)
          .map((t) => Number(/(\d+)$/.exec(t.name)?.[1] ?? 0));
        const size = req.size ?? 1;
        const at = placeToken(mapBox(map), size, { x: req.x, y: req.y });

        const row = await tx.token.create({
          data: {
            mapId: map.id,
            type: 'monster',
            ownerParticipantId: null,
            name: `${label} ${Math.max(0, ...highest) + 1}`,
            iconUrl,
            x: at.x,
            y: at.y,
            size,
            visibleToPlayers: req.visible ?? true,
          },
        });
        const { version } = await bumpVersion(tx, sessionId);
        await logEvent(tx, sessionId, participantId, 'token.create', {
          tokenId: row.id,
          name: row.name,
          at: { x: at.x, y: at.y },
          visible: row.visibleToPlayers,
        });
        return changeOf(version, row, false);
      });
    },

    /**
     * Puts `ownerId`'s character on the current map; every player has at most one per map.
     * `actorId` is who asked (the player themselves or the master) and goes to the audit log.
     */
    async placeCharacter(
      sessionId: string,
      actorId: string,
      ownerId: string,
      req: CharacterPlace,
    ): Promise<TokenOutcome> {
      // The check below gives the usual answer; the unique index on (map, owner) is what actually
      // stops two simultaneous requests (e.g. one tap delivered twice) from both getting through.
      return prisma
        .$transaction(async (tx) => {
          const session = await tx.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: { currentMapId: true },
          });
          if (session.currentMapId !== req.mapId) return fail('map_not_found');
          const map = await tx.map.findUniqueOrThrow({ where: { id: req.mapId } });
          const player = await tx.participant.findFirst({
            where: { id: ownerId, sessionId, role: 'player' },
          });
          if (!player) return fail('participant_not_found');

          const onMap = await tx.token.findMany({
            where: { mapId: map.id },
            select: { ownerParticipantId: true },
          });
          if (onMap.some((t) => t.ownerParticipantId === ownerId)) return fail('already_placed');
          if (onMap.length >= MAX_TOKENS_PER_MAP) return fail('too_many_tokens');

          const at = placeToken(mapBox(map), 1, { x: req.x, y: req.y });
          const row = await tx.token.create({
            data: {
              mapId: map.id,
              type: 'player_character',
              ownerParticipantId: ownerId,
              name: player.displayName,
              iconUrl: player.iconUrl ?? defaultCharacterIcon(player.id),
              x: at.x,
              y: at.y,
              size: 1,
              visibleToPlayers: true,
            },
          });
          const { version } = await bumpVersion(tx, sessionId);
          await logEvent(tx, sessionId, actorId, 'token.create', {
            tokenId: row.id,
            name: row.name,
            type: 'player_character',
            owner: ownerId,
            at: { x: at.x, y: at.y },
          });
          return changeOf(version, row, false);
        })
        .catch((err: unknown) => {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            return fail('already_placed');
          }
          throw err;
        });
    },

    async move(
      sessionId: string,
      participantId: string,
      tokenId: string,
      to: Point,
      guard: Guard,
    ): Promise<TokenOutcome> {
      return prisma.$transaction(async (tx) => {
        const row = await load(tx, sessionId, tokenId);
        if (!row) return fail('token_not_found');
        if (!guard(toTokenView(row))) return fail('forbidden');

        const at = placeToken(mapBox(row.map), row.size, to);
        const updated = await tx.token.update({
          where: { id: row.id },
          data: { x: at.x, y: at.y },
        });
        const { version } = await bumpVersion(tx, sessionId);
        await logEvent(tx, sessionId, participantId, 'token.move', {
          tokenId: row.id,
          from: { x: row.x, y: row.y },
          to: { x: at.x, y: at.y },
        });
        return changeOf(version, updated, row.visibleToPlayers);
      });
    },

    async delete(
      sessionId: string,
      participantId: string,
      tokenId: string,
      guard: Guard,
    ): Promise<TokenOutcome> {
      return prisma.$transaction(async (tx) => {
        const row = await load(tx, sessionId, tokenId);
        if (!row) return fail('token_not_found');
        if (!guard(toTokenView(row))) return fail('forbidden');

        await tx.token.delete({ where: { id: row.id } });
        const { version } = await bumpVersion(tx, sessionId);
        await logEvent(tx, sessionId, participantId, 'token.delete', {
          tokenId: row.id,
          name: row.name,
        });
        return changeOf(version, row, row.visibleToPlayers, true);
      });
    },

    async setVisibility(
      sessionId: string,
      participantId: string,
      tokenId: string,
      visible: boolean,
      guard: Guard,
    ): Promise<TokenOutcome> {
      return prisma.$transaction(async (tx) => {
        const row = await load(tx, sessionId, tokenId);
        if (!row) return fail('token_not_found');
        if (!guard(toTokenView(row))) return fail('forbidden');

        const updated = await tx.token.update({
          where: { id: row.id },
          data: { visibleToPlayers: visible },
        });
        const { version } = await bumpVersion(tx, sessionId);
        await logEvent(tx, sessionId, participantId, 'token.visibility', {
          tokenId: row.id,
          visible,
        });
        return changeOf(version, updated, row.visibleToPlayers);
      });
    },
  };
}
