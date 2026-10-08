import { useEffect, useState } from 'react';

export interface LoadedImage {
  url: string;
  image: HTMLImageElement | null;
  failed: boolean;
}

/** Returns null while `url` is loading, so a new map never shows the previous map's picture. */
export function useLoadedImage(url: string): LoadedImage | null {
  const [result, setResult] = useState<LoadedImage | null>(null);

  useEffect(() => {
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

  return result?.url === url ? result : null;
}
