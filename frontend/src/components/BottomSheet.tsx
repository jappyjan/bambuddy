/**
 * Bottom sheet for small screens (slicer UX redesign, spec §7 step 3 — mockup
 * screen 1 option A, the phone column).
 *
 * This is a *container*, not a panel. It pins whatever it is handed to the
 * bottom of the viewport behind a backdrop, adds the grabber the mockup draws,
 * and handles the drag. `FileManagerPage` puts the very same
 * `FileInspectorPanel` in here that the desktop rail mounts — there is no
 * mobile-only inspector, which is the whole point of the panel taking its
 * layout as a `className`.
 *
 * Two snap points, as the mockup annotates ("the same panel arrives as a bottom
 * sheet you can drag up to full height"): `peek` shows the title, the metadata
 * and the top of the action stack; `full` fills the screen. Dragging down steps
 * back the other way, full → peek → dismissed, so a drag never destroys the
 * selection in one stroke from the expanded state. Tapping the backdrop
 * dismisses from either.
 *
 * The drag is wired to *touch* events only, deliberately. The sheet renders
 * only under `useIsMobile()`, so a touch screen is the only input that can ever
 * reach it; mouse-drag support would be code no user and no test exercises.
 * (jsdom agrees by accident — it implements TouchEvent but not PointerEvent, so
 * touch is also the only gesture the test suite can drive faithfully.)
 *
 * Only the grabber strip starts a drag. The panel inside scrolls, and letting
 * the whole surface drag would mean arbitrating between "scroll the metadata"
 * and "resize the sheet" on every touchmove — `touch-none` on that one strip
 * avoids the arbitration entirely.
 */

import { useRef, useState, type ReactNode } from 'react';

/** Vertical travel, in px, that commits a drag to the next snap point. */
const DRAG_THRESHOLD = 60;

export interface BottomSheetProps {
  /** Drag past the bottom snap point, or tap the backdrop. */
  onDismiss: () => void;
  /** Accessible name for the backdrop's dismiss target. */
  closeLabel: string;
  children: ReactNode;
}

export function BottomSheet({ onDismiss, closeLabel, children }: BottomSheetProps) {
  const [expanded, setExpanded] = useState(false);
  /** Live finger offset while dragging; 0 when settled on a snap point. */
  const [dragY, setDragY] = useState(0);
  const startY = useRef<number | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    startY.current = e.touches[0]?.clientY ?? null;
    setDragY(0);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const y = e.touches[0]?.clientY;
    if (startY.current === null || y === undefined) return;
    setDragY(y - startY.current);
  };

  const handleTouchEnd = () => {
    const delta = dragY;
    startY.current = null;
    setDragY(0);
    if (delta <= -DRAG_THRESHOLD) {
      setExpanded(true);
    } else if (delta >= DRAG_THRESHOLD) {
      // full → peek → gone. A short drag from peek closes; from full it only
      // collapses, so the user cannot lose the file they were reading in one
      // careless swipe.
      if (expanded) setExpanded(false);
      else onDismiss();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        data-testid="bottom-sheet-backdrop"
        aria-label={closeLabel}
        onClick={onDismiss}
        className="absolute inset-0 w-full h-full bg-black/60"
      />
      <div
        data-testid="bottom-sheet"
        data-snap={expanded ? 'full' : 'peek'}
        className={`relative flex flex-col min-h-0 rounded-t-2xl bg-bambu-dark-secondary border-t border-bambu-dark-tertiary shadow-[0_-8px_20px_rgba(0,0,0,0.5)] transition-[height] duration-200 ${
          expanded ? 'h-full' : 'h-[60%]'
        }`}
        // Only follow the finger downwards: dragging up is a snap-point change,
        // not a free resize, so the sheet stays put until the drag commits.
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
      >
        <div
          data-testid="bottom-sheet-handle"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
          className="flex-shrink-0 flex justify-center py-2.5 touch-none cursor-grab"
        >
          <span aria-hidden="true" className="block w-10 h-1 rounded-full bg-bambu-gray/50" />
        </div>
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
