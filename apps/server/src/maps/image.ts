import { ICON_SIZE, MAX_IMAGE_SIDE } from '@dnd-map/shared';
import sharp, { type Metadata } from 'sharp';

export const PREVIEW_MAX_SIDE = 2048;

export type ImageErrorCode = 'invalid_image' | 'unsupported_format' | 'image_too_large';

export class ImageError extends Error {
  constructor(readonly code: ImageErrorCode) {
    super(code);
  }
}

const FORMATS = { jpeg: 'jpg', png: 'png', webp: 'webp' } as const;

export interface ProcessedImage {
  ext: (typeof FORMATS)[keyof typeof FORMATS];
  /** Size as displayed, i.e. after applying the EXIF orientation. */
  width: number;
  height: number;
  /** WebP copy that fits into PREVIEW_MAX_SIDE. */
  preview: Buffer;
}

// Caps the number of pixels sharp is willing to decode (protects against decompression bombs).
const limitInputPixels = MAX_IMAGE_SIDE * MAX_IMAGE_SIDE;

/**
 * Decides what an upload really is by looking at its bytes, not at the declared type or
 * file name, and rejects anything that is not a reasonably sized JPEG, PNG or WebP.
 */
async function inspect(input: Buffer): Promise<Pick<ProcessedImage, 'ext' | 'width' | 'height'>> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels }).metadata();
  } catch {
    throw new ImageError('invalid_image');
  }

  const ext =
    meta.format && meta.format in FORMATS ? FORMATS[meta.format as keyof typeof FORMATS] : null;
  if (!ext) throw new ImageError('unsupported_format');
  if (!meta.width || !meta.height) throw new ImageError('invalid_image');

  // EXIF orientations 5-8 are rotated by 90 degrees: browsers show the image with swapped sides.
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) throw new ImageError('image_too_large');
  return { ext, width, height };
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const { ext, width, height } = await inspect(input);

  let preview: Buffer;
  try {
    preview = await sharp(input, { limitInputPixels })
      .rotate()
      .resize({
        width: PREVIEW_MAX_SIDE,
        height: PREVIEW_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    // The header looked fine but the pixel data is broken or exceeds the decoder's limits.
    throw new ImageError('invalid_image');
  }

  return { ext, width, height, preview };
}

/**
 * Turns an uploaded picture into a character icon: centre-cropped to a square, scaled to
 * ICON_SIZE and re-encoded as WebP (this also drops any metadata). It is shown as a circle by the client.
 */
export async function processIcon(input: Buffer): Promise<Buffer> {
  await inspect(input);
  try {
    return await sharp(input, { limitInputPixels })
      .rotate()
      .resize(ICON_SIZE, ICON_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw new ImageError('invalid_image');
  }
}
