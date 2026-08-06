import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import FullScreenDoc from '../components/FullScreenDoc';
import DocumentPreview from '../components/DocumentPreview';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

interface Customer {
  id: string;
  name: string;
}
interface QuoteItem {
  id: string;
  description: string;
  qty: number;
  unit_price: number;
}
interface Quote {
  id: string;
  number: string;
  customer_id: string | null;
  customer_name: string | null;
  issue_date: string;
  status: 'draft' | 'sent' | 'accepted' | 'declined';
  notes: string | null;
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

export default function SalesQuotesPage() {
  const t = useT();
  const [items, setItems] = useState<Quote[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingStatus, setEditingStatus] = useState<Quote['status']>('draft');
  const [customerId, setCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<ItemRow[]>([emptyRow()]);
  const [number, setNumber] = useState('');

  function load() {
    get<{ quotes: Quote[] }>('/sales-quotes')
      .then((r) => setItems(r.quotes))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.salesQuotes.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ customers: Customer[] }>('/customers').then((r) => setCustomers(r.customers)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetForm() {
    setCustomerId('');
    setIssueDate(new Date().toISOString().slice(0, 10));
    setNotes('');
    setRows([emptyRow()]);
    setNumber('');
    setEditingStatus('draft');
  }

  function openCreate() {
    resetForm();
    setEditingId(null);
    setOpen(true);
  }

  async function openEdit(q: Quote) {
    setError(null);
    try {
      const r = await get<{ quote: Quote; items: QuoteItem[] }>(`/sales-quotes/${q.id}`);
      setEditingId(q.id);
      setEditingStatus(r.quote.status);
      setCustomerId(r.quote.customer_id || '');
      setIssueDate(r.quote.issue_date ? r.quote.issue_date.slice(0, 10) : '');
      setNotes(r.quote.notes || '');
      setNumber(r.quote.number);
      setRows(
        r.items.length > 0
          ? r.items.map((it) => ({ description: it.description, qty: String(it.qty), unitPrice: String(it.unit_price) }))
          : [emptyRow()]
      );
      setOpen(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.salesQuotes.loadFailed);
    }
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

  const isLocked = editingId !== null && editingStatus !== 'draft';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanItems = rows
      .filter((r) => r.description.trim() && Number(r.qty) > 0)
      .map((r) => ({ description: r.description.trim(), qty: Number(r.qty), unit_price: Number(r.unitPrice) || 0 }));
    if (cleanItems.length === 0) {
      setError(t.salesQuotes.needItem);
      return;
    }
    setLoading(true);
    try {
      const payload = { customer_id: customerId || undefined, issue_date: issueDate || undefined, notes: notes || undefined, items: cleanItems };
      if (editingId) {
        await patch(`/sales-quotes/${editingId}`, payload);
      } else {
        await post('/sales-quotes', payload);
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.salesQuotes.updateFailed : t.salesQuotes.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function markSent(q: Quote) {
    setError(null);
    try {
      await patch(`/sales-quotes/${q.id}`, { status: 'sent' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.salesQuotes.updateFailed);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.salesQuotes.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/sales-quotes/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.salesQuotes.deleteFailed);
    }
  }

  function statusLabel(s: Quote['status']) {
    return t.salesQuotes.status[s];
  }

  const previewItems = rows.map((r) => ({ description: r.description, qty: Number(r.qty) || 0, unitPrice: Number(r.unitPrice) || 0 }));
  const customerName = customers.find((c) => c.id === customerId)?.name || '';

  return (
    <div>
      <PageHeader title={t.salesQuotes.title} subtitle={t.salesQuotes.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.salesQuotes.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.salesQuotes.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.salesQuotes.number}</th>
                <th>{t.salesQuotes.customer}</th>
                <th>{t.salesQuotes.issueDate}</th>
                <th>{t.salesQuotes.status.label}</th>
                <th>{t.salesQuotes.total}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((q) => (
                <tr key={q.id}>
                  <td style={{ fontWeight: 700 }}>{q.number}</td>
                  <td>{q.customer_name || '—'}</td>
                  <td className="num">{q.issue_date ? q.issue_date.slice(0, 10) : '—'}</td>
                  <td>
                    <span className={`badge ${q.status === 'draft' ? 'closed' : q.status === 'accepted' ? 'open' : q.status === 'declined' ? 'cancelled' : 'trial'}`}>
                      {statusLabel(q.status)}
                    </span>
                  </td>
                  <td className="num">{q.total.toFixed(3)} KD</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn" title={t.salesQuotes.editItem} onClick={() => openEdit(q)}>
                      <IconEdit />
                    </button>
                    {q.status === 'draft' && (
                      <>
                        <button className="btn btn-secondary btn-sm" onClick={() => markSent(q)}>
                          {t.salesQuotes.markSent}
                        </button>
                        <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(q.id)}>
                          <IconTrash />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">{t.salesQuotes.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <FullScreenDoc
          title={editingId ? `${t.salesQuotes.editItem} — ${number}` : t.salesQuotes.newItem}
          onClose={() => setOpen(false)}
          actions={
            !isLocked ? (
              <button className="btn btn-primary btn-sm" type="submit" form="quote-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
            ) : undefined
          }
        >
          <div className="doc-split">
            <form id="quote-form" onSubmit={handleSubmit}>
              {isLocked && <div className="error-banner">{t.salesQuotes.lockedNotice}</div>}
              <div className="field">
                <label>{t.salesQuotes.customer}</label>
                <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={isLocked}>
                  <option value="">{t.salesQuotes.selectCustomer}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>{t.salesQuotes.issueDate}</label>
                <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} disabled={isLocked} />
              </div>
              <div className="field">
                <label>{t.salesQuotes.notes}</label>
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={isLocked} />
              </div>

              <div className="field">
                <label>{t.salesQuotes.items}</label>
                {rows.map((row, i) => (
                  <div key={i} className="doc-item-row">
                    <input
                      placeholder={t.salesQuotes.itemDescription}
                      value={row.description}
                      onChange={(e) => updateRow(i, { description: e.target.value })}
                      disabled={isLocked}
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      placeholder={t.salesQuotes.qty}
                      value={row.qty}
                      onChange={(e) => updateRow(i, { qty: e.target.value })}
                      disabled={isLocked}
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      placeholder={t.salesQuotes.unitPrice}
                      value={row.unitPrice}
                      onChange={(e) => updateRow(i, { unitPrice: e.target.value })}
                      disabled={isLocked}
                    />
                    {!isLocked && (
                      <button type="button" className="icon-btn" title={t.common.delete} onClick={() => removeRow(i)}>
                        <IconTrash />
                      </button>
                    )}
                  </div>
                ))}
                {!isLocked && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
                    <IconPlus /> {t.salesQuotes.addItem}
                  </button>
                )}
              </div>
            </form>

            <DocumentPreview
              docTypeLabel={t.salesQuotes.docLabel}
              number={number || t.salesQuotes.numberPending}
              date={issueDate}
              customerName={customerName}
              items={previewItems}
              notes={notes}
            />
          </div>
        </FullScreenDoc>
      )}
    </div>
  );
}
