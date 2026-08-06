import { FormEvent, useEffect, useState } from 'react';
import { get, post, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import FullScreenDoc from '../components/FullScreenDoc';
import DocumentPreview from '../components/DocumentPreview';
import { IconPlus, IconTrash } from '../components/Icon';

interface Customer {
  id: string;
  name: string;
}
interface CashInvoice {
  id: string;
  number: string;
  customer_id: string | null;
  customer_name: string | null;
  issue_date: string;
  total: number;
}
interface ItemRow {
  description: string;
  qty: string;
  unitPrice: string;
}

function emptyRow(): ItemRow {
  return { description: '', qty: '1', unitPrice: '' };
}

// Cash invoices are paid on the spot — no due date, no draft/sent workflow. The backend
// (salesInvoices.controller.ts create() with type: 'cash') marks them 'paid' with
// amount_paid = total immediately, so this page only ever needs create + list, no
// status transitions or edit-after-the-fact (see the controller comment on why).
export default function CashInvoicesPage() {
  const t = useT();
  const [items, setItems] = useState<CashInvoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [defaultNotes, setDefaultNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<ItemRow[]>([emptyRow()]);

  function load() {
    get<{ invoices: CashInvoice[] }>('/sales-invoices?type=cash')
      .then((r) => setItems(r.invoices))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.cashInvoices.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ customers: Customer[] }>('/customers').then((r) => setCustomers(r.customers)).catch(() => {});
    get<{ default_sales_notes: string | null }>('/company/me').then((r) => setDefaultNotes(r.default_sales_notes || '')).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    setCustomerId('');
    setIssueDate(new Date().toISOString().slice(0, 10));
    setNotes(defaultNotes);
    setRows([emptyRow()]);
    setOpen(true);
  }

  function addRow() {
    setRows((r) => [...r, emptyRow()]);
  }
  function updateRow(i: number, patchRow: Partial<ItemRow>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patchRow } : row)));
  }
  function removeRow(i: number) {
    setRows((r) => r.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanItems = rows
      .filter((r) => r.description.trim() && Number(r.qty) > 0)
      .map((r) => ({ description: r.description.trim(), qty: Number(r.qty), unit_price: Number(r.unitPrice) || 0 }));
    if (cleanItems.length === 0) {
      setError(t.cashInvoices.needItem);
      return;
    }
    setLoading(true);
    try {
      await post('/sales-invoices', { type: 'cash', customer_id: customerId || undefined, issue_date: issueDate, notes: notes || undefined, items: cleanItems });
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.cashInvoices.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  const previewItems = rows.map((r) => ({ description: r.description, qty: Number(r.qty) || 0, unitPrice: Number(r.unitPrice) || 0 }));
  const customerName = customers.find((c) => c.id === customerId)?.name || '';

  return (
    <div>
      <PageHeader title={t.cashInvoices.title} subtitle={t.cashInvoices.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.cashInvoices.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.cashInvoices.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.cashInvoices.number}</th>
                <th>{t.cashInvoices.customer}</th>
                <th>{t.cashInvoices.issueDate}</th>
                <th>{t.cashInvoices.total}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((inv) => (
                <tr key={inv.id}>
                  <td style={{ fontWeight: 700 }}>{inv.number}</td>
                  <td>{inv.customer_name || '—'}</td>
                  <td className="num">{inv.issue_date.slice(0, 10)}</td>
                  <td className="num">{inv.total.toFixed(3)} KD</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <div className="empty-state">{t.cashInvoices.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <FullScreenDoc
          title={t.cashInvoices.newItem}
          onClose={() => setOpen(false)}
          actions={
            <button className="btn btn-primary btn-sm" type="submit" form="cash-invoice-form" disabled={loading}>
              {loading ? t.common.loading : t.cashInvoices.saveAsPaid}
            </button>
          }
        >
          <div className="doc-split">
            <form id="cash-invoice-form" onSubmit={handleSubmit}>
              <div className="field">
                <label>{t.cashInvoices.customer}</label>
                <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">{t.cashInvoices.selectCustomer}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>{t.cashInvoices.issueDate}</label>
                <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
              </div>
              <div className="field">
                <label>{t.cashInvoices.notes}</label>
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>

              <div className="field">
                <label>{t.cashInvoices.items}</label>
                {rows.map((row, i) => (
                  <div key={i} className="doc-item-row">
                    <input placeholder={t.cashInvoices.itemDescription} value={row.description} onChange={(e) => updateRow(i, { description: e.target.value })} />
                    <input type="number" min="0" step="0.001" placeholder={t.cashInvoices.qty} value={row.qty} onChange={(e) => updateRow(i, { qty: e.target.value })} />
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      placeholder={t.cashInvoices.unitPrice}
                      value={row.unitPrice}
                      onChange={(e) => updateRow(i, { unitPrice: e.target.value })}
                    />
                    <button type="button" className="icon-btn" title={t.common.delete} onClick={() => removeRow(i)}>
                      <IconTrash />
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
                  <IconPlus /> {t.cashInvoices.addItem}
                </button>
              </div>
            </form>

            <DocumentPreview docTypeLabel={t.cashInvoices.docLabel} number={t.cashInvoices.numberPending} date={issueDate} customerName={customerName} items={previewItems} notes={notes} />
          </div>
        </FullScreenDoc>
      )}
    </div>
  );
}
