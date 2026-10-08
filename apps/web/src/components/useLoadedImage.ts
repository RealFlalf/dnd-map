import { useEffect, useState } from 'react';

export interface LoadedImage {
  url: string;
  image: HTMLImageElement | null;
  failed: boolean;
}

/**
 * Returns null while `url` is loading (and when there is no url), so a new picture never shows
 * the previous one.
 */
export function useLoadedImage(url: string | null): LoadedImage | null {
  const [result, setResult] = useState<LoadedImage | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const image = new window.Image();
    image.onload = () => !cancelled && setResult({ url, image, failed: false });
    image.onerror = () => !cancelled && setResult({ url, image: null, failed: true });
    image.src = url;
    return () => {
      cancelled = true;
      image.onload = image.onerror = null;
    };
  }, [url]);

  return url && result?.url === url ? result : null;
}
