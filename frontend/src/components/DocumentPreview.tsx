import { useAuthStore } from '../store/authStore';
import { useT } from '../i18n';

export interface PreviewItem {
  description: string;
  qty: number;
  unitPrice: number;
}

interface DocumentPreviewProps {
  docTypeLabel: string;
  number: string;
  date: string;
  dueDate?: string;
  customerName: string;
  items: PreviewItem[];
  notes?: string;
}

// Shared "paper" preview used by both the quote and invoice editors — a live read-only
// rendering of the document being built, matching the split-pane layout in the Wafeq
// reference screenshots (form on one side, a preview that updates as you type on the
// other). No tax/VAT line — Kuwait has no VAT, so subtotal and total are always equal.
export default function DocumentPreview({ docTypeLabel, number, date, dueDate, customerName, items, notes }: DocumentPreviewProps) {
  const company = useAuthStore((s) => s.company);
  const t = useT();
  const total = items.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);

  return (
    <div className="doc-paper">
      <div className="doc-paper-head">
        <div className="doc-company">
          {company?.name || 'macrocore'}
          <div className="muted" style={{ fontSize: 12 }}>{t.salesDocs.kuwait}</div>
        </div>
        <div style={{ textAlign: 'end' }}>
          <div className="doc-paper-title">{docTypeLabel}</div>
          <div className="doc-paper-meta">{number || '—'}</div>
          <div className="doc-paper-meta">{date || '—'}</div>
          {dueDate && <div className="doc-paper-meta">{t.salesDocs.due}: {dueDate}</div>}
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{t.salesDocs.billTo}</div>
      <div style={{ fontWeight: 700 }}>{customerName || t.salesDocs.noCustomer}</div>

      <table className="data-table">
        <thead>
          <tr>
            <th>{t.salesDocs.description}</th>
            <th className="num">{t.salesDocs.qty}</th>
            <th className="num">{t.salesDocs.unitPrice}</th>
            <th className="num">{t.salesDocs.lineTotal}</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={4}>
                <div className="empty-state">{t.salesDocs.noItemsYet}</div>
              </td>
            </tr>
          )}
          {items.map((it, idx) => (
            <tr key={idx}>
              <td>{it.description || '—'}</td>
              <td className="num">{it.qty || 0}</td>
              <td className="num">{(it.unitPrice || 0).toFixed(3)}</td>
              <td className="num">{((it.qty || 0) * (it.unitPrice || 0)).toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="doc-paper-totals">
        <div className="row total">
          <span>{t.salesDocs.total}</span>
          <span>{total.toFixed(3)} KD</span>
        </div>
      </div>

      {notes && (
        <div style={{ marginTop: 20 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{t.salesDocs.notes}</div>
          <div style={{ fontSize: 13 }}>{notes}</div>
        </div>
      )}
    </div>
  );
}
