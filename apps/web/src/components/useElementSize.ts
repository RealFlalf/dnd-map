import { useCallback, useEffect, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

/** Tracks the content box of an element. Returns a callback ref to attach, the size and the element. */
export function useElementSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  Size,
  T | null,
] {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const ref = useCallback((el: T | null) => setNode(el), []);

  useEffect(() => {
    if (!node) return;
    const update = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [ref, size, node];
}
