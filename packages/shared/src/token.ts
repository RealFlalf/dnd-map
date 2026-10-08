import { z } from 'zod';
import type { ActionResult, GridSettings } from './map';
import type { TokenType } from './permissions';

export const MAX_TOKENS_PER_MAP = 100;
export const TOKEN_SIZE_MAX = 4;

export interface BuiltinIcon {
  id: string;
  label: string;
  /** Emoji drawn on the token. */
  glyph: string;
  color: string;
}

/** Monster icons shipped with the app. Stored on a token as `builtin:<id>`. */
export const MONSTER_ICONS: readonly BuiltinIcon[] = [
  { id: 'goblin', label: 'Гоблин', glyph: '👺', color: '#5d8a3a' },
  { id: 'orc', label: 'Орк', glyph: '👹', color: '#7a4a2b' },
  { id: 'skeleton', label: 'Скелет', glyph: '💀', color: '#8d8a80' },
  { id: 'zombie', label: 'Зомби', glyph: '🧟', color: '#4f6b4a' },
  { id: 'ghost', label: 'Призрак', glyph: '👻', color: '#6c7a96' },
  { id: 'dragon', label: 'Дракон', glyph: '🐉', color: '#a63a2e' },
  { id: 'wolf', label: 'Волк', glyph: '🐺', color: '#5b5f66' },
  { id: 'spider', label: 'Паук', glyph: '🕷️', color: '#3b3342' },
  { id: 'bat', label: 'Летучая мышь', glyph: '🦇', color: '#443a5c' },
  { id: 'rat', label: 'Крыса', glyph: '🐀', color: '#7d6a58' },
  { id: 'snake', label: 'Змея', glyph: '🐍', color: '#3f7a52' },
  { id: 'scorpion', label: 'Скорпион', glyph: '🦂', color: '#9c5b2a' },
  { id: 'bear', label: 'Медведь', glyph: '🐻', color: '#6b4a32' },
  { id: 'demon', label: 'Демон', glyph: '😈', color: '#8c2f5b' },
  { id: 'vampire', label: 'Вампир', glyph: '🧛', color: '#6e2431' },
  { id: 'mage', label: 'Маг', glyph: '🧙', color: '#3f4f8f' },
  { id: 'golem', label: 'Голем', glyph: '🗿', color: '#76716a' },
  { id: 'slime', label: 'Слизь', glyph: '🦠', color: '#4c9a6b' },
  { id: 'boss', label: 'Босс', glyph: '👑', color: '#b08a1f' },
  { id: 'monster', label: 'Чудовище', glyph: '👾', color: '#6a4c93' },
];

/** Icons players can pick for their character. Ids never clash with monster ids. */
export const PLAYER_ICONS: readonly BuiltinIcon[] = [
  { id: 'fighter', label: 'Воин', glyph: '⚔️', color: '#8a3b2f' },
  { id: 'knight', label: 'Рыцарь', glyph: '🤺', color: '#4a5d7a' },
  { id: 'paladin', label: 'Паладин', glyph: '🛡️', color: '#b08a1f' },
  { id: 'barbarian', label: 'Варвар', glyph: '🪓', color: '#7a4a2b' },
  { id: 'wizard', label: 'Волшебник', glyph: '🧙', color: '#3f4f8f' },
  { id: 'sorcerer', label: 'Чародей', glyph: '🔮', color: '#7a3f8f' },
  { id: 'warlock', label: 'Колдун', glyph: '📿', color: '#5b3a6e' },
  { id: 'cleric', label: 'Жрец', glyph: '⚕️', color: '#9c8a3a' },
  { id: 'druid', label: 'Друид', glyph: '🌿', color: '#3f7a52' },
  { id: 'ranger', label: 'Следопыт', glyph: '🏹', color: '#4f6b4a' },
  { id: 'rogue', label: 'Плут', glyph: '🥷', color: '#3b3342' },
  { id: 'monk', label: 'Монах', glyph: '🥋', color: '#a0622a' },
  { id: 'bard', label: 'Бард', glyph: '🎻', color: '#9c4a6b' },
  { id: 'elf', label: 'Эльф', glyph: '🧝', color: '#3f8a7a' },
  { id: 'dwarf', label: 'Дварф', glyph: '🧔', color: '#8a5a2b' },
  { id: 'hero', label: 'Герой', glyph: '🦸', color: '#2f6b9c' },
];

export const BUILTIN_ICON_PREFIX = 'builtin:';

export function findBuiltinIcon(icon: string): BuiltinIcon | undefined {
  if (!icon.startsWith(BUILTIN_ICON_PREFIX)) return undefined;
  const id = icon.slice(BUILTIN_ICON_PREFIX.length);
  return MONSTER_ICONS.find((i) => i.id === id) ?? PLAYER_ICONS.find((i) => i.id === id);
}

/** Uploaded icons are served from here (see the icon upload route). */
export const FILES_URL_PREFIX = '/api/files/';

export const MAX_ICON_BYTES = 2 * 1024 * 1024;
export const ICON_SIZE = 256;

/** A player who has not chosen an icon gets one of the shipped icons, spread by participant id. */
export function defaultCharacterIcon(participantId: string): string {
  let sum = 0;
  for (const char of participantId) sum = (sum + char.charCodeAt(0)) % 9973;
  return BUILTIN_ICON_PREFIX + PLAYER_ICONS[sum % PLAYER_ICONS.length]!.id;
}

/** What a client may know about a token. Hidden monsters are never sent to players at all. */
export interface TokenView {
  id: string;
  mapId: string;
  type: TokenType;
  ownerParticipantId: string | null;
  name: string;
  /** `builtin:<id>` for shipped icons, otherwise a URL. */
  icon: string;
  /** Centre of the token in source-image pixels. */
  x: number;
  y: number;
  /** Footprint in grid cells. */
  size: number;
  visible: boolean;
}

/** Incremental change of the tokens on the current map; an empty patch just advances the version. */
export interface TokensPatch {
  version: number;
  upserted: TokenView[];
  removedIds: string[];
}

/** Position of a token while someone is still dragging it; never stored. */
export interface TokenDragging {
  tokenId: string;
  x: number;
  y: number;
}

const coordinate = z.number().min(-1_000_000).max(1_000_000);
const id = z.string().min(1).max(64);

export const tokenCreateSchema = z.object({
  mapId: id,
  icon: z.enum(MONSTER_ICONS.map((i) => i.id) as [string, ...string[]]),
  size: z.number().int().min(1).max(TOKEN_SIZE_MAX).optional(),
  x: coordinate,
  y: coordinate,
  /** Placing a monster hidden lets the master prepare an ambush. Defaults to visible. */
  visible: z.boolean().optional(),
});
export type TokenCreate = z.input<typeof tokenCreateSchema>;

export const tokenMoveSchema = z.object({ tokenId: id, x: coordinate, y: coordinate });
export type TokenMove = z.input<typeof tokenMoveSchema>;

export const tokenRefSchema = z.object({ tokenId: id });
export type TokenRef = z.input<typeof tokenRefSchema>;

export const tokenVisibilitySchema = z.object({ tokenId: id, visible: z.boolean() });
export type TokenVisibility = z.input<typeof tokenVisibilitySchema>;

export const characterIconSchema = z.object({
  icon: z.enum(PLAYER_ICONS.map((i) => i.id) as [string, ...string[]]),
});
export type CharacterIconRequest = z.input<typeof characterIconSchema>;

export const characterPlaceSchema = z.object({ mapId: id, x: coordinate, y: coordinate });
export type CharacterPlace = z.input<typeof characterPlaceSchema>;

/** The icon now stored for the character (`builtin:<id>` or a file URL). */
export type CharacterIconResult = ActionResult<{ icon: string }>;

export type TokenResult = ActionResult<{ version: number; token: TokenView }>;
export type TokenDeleteResult = ActionResult<{ version: number }>;

export interface Point {
  x: number;
  y: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const EDGE = 0.001;

export function clampToMap(map: { width: number; height: number }, p: Point): Point {
  return { x: clamp(p.x, 0, map.width), y: clamp(p.y, 0, map.height) };
}

/**
 * Moves a point to where a token of `size` cells would sit on the grid: the middle of a cell for odd
 * sizes, a grid-line crossing for even ones (a 2x2 creature covers four whole cells).
 */
export function snapToGrid(grid: GridSettings, size: number, p: Point): Point {
  const snap = (value: number, offset: number) => {
    const cells = (value - offset) / grid.scale;
    const snapped = size % 2 === 1 ? Math.floor(cells) + 0.5 : Math.round(cells);
    return offset + snapped * grid.scale;
  };
  return { x: snap(p.x, grid.offsetX), y: snap(p.y, grid.offsetY) };
}

/** Where a token ends up when dropped at `p`: snapped if the map asks for it, always inside the map. */
export function placeToken(
  map: { width: number; height: number; grid: GridSettings },
  size: number,
  p: Point,
): Point {
  if (!map.grid.snap) return clampToMap(map, p);
  // Clamp first (just inside the far edge) so a point dropped outside lands in the last cell
  // instead of in a cell centre beyond the map, then clamp again for partial cells at the edge.
  const inside = clampToMap({ width: map.width - EDGE, height: map.height - EDGE }, p);
  return clampToMap(map, snapToGrid(map.grid, size, inside));
}

/** 1-based column and row of the cell under a point, for showing coordinates to people. */
export function cellOf(grid: GridSettings, p: Point): { col: number; row: number } {
  return {
    col: Math.floor((p.x - grid.offsetX) / grid.scale) + 1,
    row: Math.floor((p.y - grid.offsetY) / grid.scale) + 1,
  };
}
