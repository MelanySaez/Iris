import { useEffect, useRef, useState } from 'react';

export const DATA_NOTES_TEXT =
  'sky = DR1 All-Sky Cube visualization; plate = Level-2 detector cutout; WCS-WAVE wavelengths are approximate, not calibrated CWAVE/CBAND; flags are a bitmask, not a quality score.';

export function DataNotesPopover() {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className="data-notes-wrap" ref={containerRef}>
      <button
        type="button"
        className="data-notes-badge"
        aria-expanded={isOpen}
        aria-controls="data-notes-popover"
        aria-haspopup="dialog"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="dot" aria-hidden="true" />
        Data notes
      </button>

      {isOpen && (
        <div
          id="data-notes-popover"
          className="data-notes-popover"
          role="dialog"
          aria-label="SPHEREx DR1 Data Notes"
        >
          <div className="popover-header">
            <strong>Data Notes</strong>
            <button
              type="button"
              className="popover-close"
              aria-label="Close data notes"
              onClick={() => setIsOpen(false)}
            >
              ×
            </button>
          </div>
          <p className="popover-body">{DATA_NOTES_TEXT}</p>
        </div>
      )}
    </div>
  );
}
