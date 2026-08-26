import { useT } from '../i18n';

// Generic Prev/Next pager driven by a backend { total, page, limit } response — first
// real pagination control in the app (see Activity Log roadmap, Phase 00). Kept
// intentionally simple (no page-number list) since audit_logs can run into the
// hundreds of thousands of rows; Prev/Next never needs to render a page count that big.
export default function Pagination({
  page,
  limit,
  total,
  onChange,
}: {
  page: number;
  limit: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const t = useT();
  const totalPages = Math.max(1, Math.ceil(total / limit));

  if (totalPages <= 1) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '14px 0' }}>
      <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        {t.common.previous}
      </button>
      <span className="muted" style={{ fontSize: 13 }}>
        {t.common.pageOf(page, totalPages)}
      </span>
      <button className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        {t.common.next}
      </button>
    </div>
  );
}
