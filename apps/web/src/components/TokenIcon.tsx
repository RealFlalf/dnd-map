import { findBuiltinIcon } from '@dnd-map/shared';

export const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

/** Look of a token icon: colour and glyph. Unknown icons (e.g. custom ones later) get a neutral disc. */
export function iconStyle(icon: string): { color: string; glyph: string } {
  const builtin = findBuiltinIcon(icon);
  return builtin
    ? { color: builtin.color, glyph: builtin.glyph }
    : { color: '#6b665e', glyph: '?' };
}

/** Round icon for palettes and lists; the map itself draws tokens on the canvas. */
export function TokenIcon({ icon, size = 32 }: { icon: string; size?: number }) {
  const { color, glyph } = iconStyle(icon);
  return (
    <span
      className="token-icon"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: size * 0.58,
        fontFamily: EMOJI_FONT,
      }}
    >
      {glyph}
    </span>
  );
}
