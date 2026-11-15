import type { ConsentLevel } from '../../consent';

interface ConsentBarProps {
  onChoose: (level: ConsentLevel) => void;
  saving: boolean;
  error: string | null;
}

/** Footer bar asking for cookie consent; Records are saved only after accepting. */
export function ConsentBar({ onChoose, saving, error }: ConsentBarProps) {
  return (
    <section className="consent-bar" role="region" aria-label="Cookie consent">
      <p className="consent-bar-text">
        Iris has no accounts, so it uses a cookie to keep your saved selections in this browser. The
        necessary cookies are enough to save them; without cookies your selections (Records) cannot be
        saved.
      </p>
      {error && (
        <p className="consent-bar-error" role="alert">
          Could not save your choice: {error}
        </p>
      )}
      <div className="consent-bar-actions">
        <button type="button" className="records-btn" disabled={saving} onClick={() => onChoose('none')}>
          Reject all
        </button>
        <button type="button" className="records-btn" disabled={saving} onClick={() => onChoose('necessary')}>
          Accept necessary
        </button>
        <button
          type="button"
          className="records-btn consent-bar-primary"
          disabled={saving}
          onClick={() => onChoose('all')}
        >
          Accept all
        </button>
      </div>
    </section>
  );
}
