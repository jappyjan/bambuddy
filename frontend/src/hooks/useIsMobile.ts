import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 768;

// Tailwind's `lg`. Layouts that only split into two columns at `lg:` have no
// room for a side rail below it, so they need the phone presentation across the
// whole tablet band, not just below `MOBILE_BREAKPOINT` (#59).
const NARROW_BREAKPOINT = 1024;

function useIsBelowWidth(breakpoint: number): boolean {
  const [isBelow, setIsBelow] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsBelow(e.matches);
    };

    // Set initial value
    setIsBelow(mediaQuery.matches);

    // Modern browsers support addEventListener
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [breakpoint]);

  return isBelow;
}

export function useIsMobile(): boolean {
  return useIsBelowWidth(MOBILE_BREAKPOINT);
}

/**
 * True below 1024px — phone *and* tablet. Distinct from `useIsMobile`, which
 * stays at 768px for touch affordances; this one is for layouts whose desktop
 * form only exists at `lg:` and up.
 */
export function useIsNarrow(): boolean {
  return useIsBelowWidth(NARROW_BREAKPOINT);
}
