import '../../shared/button.css';
import { ChevronLeftIcon, ChevronRightIcon } from '../../shared/icons';

/**
 * The range of issues on the page, between previous and next chevrons; in a
 * narrow view, the range first and the chevrons together (see `view.css`).
 */
export function Pager({
  label,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  /**
   * The page's range (see `rangeLabel` in `list-model.ts`); absent while it
   * has no rows.
   */
  label?: string;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav className="pager" aria-label="Issue pages">
      <button
        type="button"
        data-size="sm"
        data-slot="step"
        aria-label="Previous page"
        title="Previous page"
        disabled={!hasPrevious}
        onClick={onPrevious}
      >
        <ChevronLeftIcon />
      </button>
      <span data-slot="range">{label}</span>
      <button
        type="button"
        data-size="sm"
        data-slot="step"
        aria-label="Next page"
        title="Next page"
        disabled={!hasNext}
        onClick={onNext}
      >
        <ChevronRightIcon />
      </button>
    </nav>
  );
}
