import { useEffect, useRef, useState } from 'react';

/**
 * A best-effort value the view can do without, such as a name for the card's
 * breadcrumbs: undefined until `load` resolves, and for good if it fails.
 * Loads again when `key` changes; an undefined `key` skips it. A value is only
 * returned for the key it was loaded for, so a stale one never shows.
 */
export function useLookup<T>(
  key: string | undefined,
  load: () => Promise<T>
): T | undefined {
  const [loaded, setLoaded] = useState<{ key: string; value: T }>();

  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
  });

  useEffect(() => {
    if (key === undefined) return;
    let isCurrent = true;
    latestLoad.current().then(
      (value) => isCurrent && setLoaded({ key, value }),
      () => {}
    );
    return () => {
      isCurrent = false;
    };
  }, [key]);

  return loaded && loaded.key === key ? loaded.value : undefined;
}
