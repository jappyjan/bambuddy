import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

interface CollapsibleProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
  /** Replaces the default `mt-3` wrapper class on the content region. */
  contentClassName?: string;
  /**
   * Keep the children mounted while closed, hidden instead of unmounted.
   *
   * Off by default, because unmounting is what most callers want: a closed
   * disclosure holding a live subtree costs render work for something nobody
   * can see. Turn it on when a child owns state that only *it* records — the
   * slicer rail's `PrinterPicker` is the case this exists for (#46): the
   * model/diameter pair a user asked for that no preset carries lives nowhere
   * else, so unmounting the section would silently discard it along with the
   * message explaining why Slice is disabled.
   *
   * Hiding is `hidden` *plus* an inline `display: none`, because the content
   * wrapper may carry a Tailwind display class (`flex`) that would otherwise
   * beat the user-agent rule for `[hidden]` and leave the subtree on screen.
   */
  keepMounted?: boolean;
  /** When provided, the component is controlled — parent owns the open state. */
  open?: boolean;
  /** Called when the user clicks the toggle. Use with `open` for controlled mode. */
  onToggle?: (open: boolean) => void;
}

/**
 * Lightweight disclosure widget.
 * Renders a clickable summary row and conditionally displays children.
 *
 * The toggle region is a plain <div> with role="button" so that the summary
 * slot may safely contain interactive elements (buttons, links) without
 * nesting a <button> inside a <button>.
 *
 * Supports both uncontrolled (internal state) and controlled (`open`/`onToggle`) modes.
 */
export function Collapsible({
  summary,
  children,
  defaultOpen = false,
  className = '',
  summaryClassName = '',
  contentClassName,
  keepMounted = false,
  open: controlledOpen,
  onToggle,
}: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;

  const handleToggle = () => {
    const next = !isOpen;
    if (!isControlled) setInternalOpen(next);
    onToggle?.(next);
  };

  return (
    <div className={className}>
      <div
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggle(); } }}
        className={`w-full flex items-center justify-between gap-2 text-left cursor-pointer ${summaryClassName}`}
        aria-expanded={isOpen}
      >
        <div className="flex-1 min-w-0">{summary}</div>
        <ChevronDown
          className={`w-4 h-4 text-bambu-gray flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </div>
      {(isOpen || keepMounted) && (
        <div
          className={contentClassName ?? 'mt-3'}
          {...(isOpen ? {} : { hidden: true, style: { display: 'none' } })}
        >
          {children}
        </div>
      )}
    </div>
  );
}
