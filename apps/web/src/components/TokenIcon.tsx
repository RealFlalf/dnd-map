import { FILES_URL_PREFIX, findBuiltinIcon } from '@dnd-map/shared';

export const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

/** How a token icon looks: a coloured disc with an emoji, or an uploaded picture. */
export type IconFace =
  { kind: 'emoji'; color: string; glyph: string } | { kind: 'image'; url: string };

export function iconFace(icon: string): IconFace {
  const builtin = findBuiltinIcon(icon);
  if (builtin) return { kind: 'emoji', color: builtin.color, glyph: builtin.glyph };
  if (icon.startsWith(FILES_URL_PREFIX)) return { kind: 'image', url: icon };
  return { kind: 'emoji', color: '#6b665e', glyph: '?' }; // unknown icon: neutral disc
}

/** Round icon for palettes and lists; the map itself draws tokens on the canvas. */
export function TokenIcon({ icon, size = 32 }: { icon: string; size?: number }) {
  const face = iconFace(icon);
  if (face.kind === 'image') {
    return (
      <img
        className="token-icon"
        src={face.url}
        alt=""
        width={size}
        height={size}
        style={{ objectFit: 'cover' }}
      />
    );
  }
  return (
    <span
      className="token-icon"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: face.color,
        fontSize: size * 0.58,
        fontFamily: EMOJI_FONT,
      }}
    >
      {face.glyph}
    </span>
  );
}
