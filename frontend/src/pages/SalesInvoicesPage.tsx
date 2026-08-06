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
interface InvoiceItem {
  id: string;
  description: string;
  qty: number;
  unit_price: number;
}
interface Invoice {
  id: string;
  number: string;
  customer_id: string | null;
  customer_name: string | null;
  issue_date: string;
  due_date: string | null;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';
  notes: string | null;
  total: number;
  amount_paid: number;
}
interface ItemRow {
  description: string;
  qty: string;
  unitPrice: string;
}

function emptyRow(): ItemRow {
  return { description: '', qty: '1', unitPrice: '' };
}

export default function SalesInvoicesPage() {
  const t = useT();
  const [items, setItems] = useState<Invoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [defaultNotes, setDefaultNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingStatus, setEditingStatus] = useState<Invoice['status']>('draft');
  const [customerId, setCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<ItemRow[]>([emptyRow()]);
  const [number, setNumber] = useState('');

  function load() {
    get<{ invoices: Invoice[] }>('/sales-invoices')
      .then((r) => setItems(r.invoices))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.salesInvoices.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ customers: Customer[] }>('/customers').then((r) => setCustomers(r.customers)).catch(() => {});
    get<{ default_sales_notes: string | null }>('/company/me').then((r) => setDefaultNotes(r.default_sales_notes || '')).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetForm() {
    setCustomerId('');
    setIssueDate(new Date().toISOString().slice(0, 10));
    setDueDate('');
    setNotes(defaultNotes);
    setRows([emptyRow()]);
    setNumber('');
    setEditingStatus('draft');
  }

  function openCreate() {
    resetForm();
    setEditingId(null);
    setOpen(true);
  }

  async function openEdit(inv: Invoice) {
    setError(null);
    try {
      const r = await get<{ invoice: Invoice; items: InvoiceItem[] }>(`/sales-invoices/${inv.id}`);
      setEditingId(inv.id);
      setEditingStatus(r.invoice.status);
      setCustomerId(r.invoice.customer_id || '');
      setIssueDate(r.invoice.issue_date ? r.invoice.issue_date.slice(0, 10) : '');
      setDueDate(r.invoice.due_date ? r.invoice.due_date.slice(0, 10) : '');
      setNotes(r.invoice.notes || '');
      setNumber(r.invoice.number);
      setRows(
        r.items.length > 0
          ? r.items.map((it) => ({ description: it.description, qty: String(it.qty), unitPrice: String(it.unit_price) }))
          : [emptyRow()]
      );
      setOpen(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.salesInvoices.loadFailed);
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
      setError(t.salesInvoices.needItem);
      return;
    }
    setLoading(true);
    try {
      const payload = {
        customer_id: customerId || undefined,
        issue_date: issueDate || undefined,
        due_date: dueDate || undefined,
        notes: notes || undefined,
        items: cleanItems,
      };
      if (editingId) {
        await patch(`/sales-invoices/${editingId}`, payload);
      } else {
        await post('/sales-invoices', payload);
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.salesInvoices.updateFailed : t.salesInvoices.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function setStatus(inv: Invoice, status: Invoice['status']) {
    setError(null);
    try {
      await patch(`/sales-invoices/${inv.id}`, { status });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.salesInvoices.updateFailed);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.salesInvoices.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/sales-invoices/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.salesInvoices.deleteFailed);
    }
  }

  function statusLabel(s: Invoice['status']) {
    return t.salesInvoices.status[s];
  }
  function statusBadgeClass(s: Invoice['status']) {
    if (s === 'paid') return 'open';
    if (s === 'cancelled') return 'cancelled';
    if (s === 'overdue') return 'cancelled';
    if (s === 'sent') return 'trial';
    return 'closed';
  }

  const previewItems = rows.map((r) => ({ description: r.description, qty: Number(r.qty) || 0, unitPrice: Number(r.unitPrice) || 0 }));
  const customerName = customers.find((c) => c.id === customerId)?.name || '';

  return (
    <div>
      <PageHeader title={t.salesInvoices.title} subtitle={t.salesInvoices.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.salesInvoices.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.salesInvoices.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.salesInvoices.number}</th>
                <th>{t.salesInvoices.customer}</th>
                <th>{t.salesInvoices.issueDate}</th>
                <th>{t.salesInvoices.dueDate}</th>
                <th>{t.salesInvoices.status.label}</th>
                <th>{t.salesInvoices.total}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((inv) => (
                <tr key={inv.id}>
                  <td style={{ fontWeight: 700 }}>{inv.number}</td>
                  <td>{inv.customer_name || '—'}</td>
                  <td className="num">{inv.issue_date ? inv.issue_date.slice(0, 10) : '—'}</td>
                  <td className="num">{inv.due_date ? inv.due_date.slice(0, 10) : '—'}</td>
                  <td>
                    <span className={`badge ${statusBadgeClass(inv.status)}`}>{statusLabel(inv.status)}</span>
                  </td>
                  <td className="num">{inv.total.toFixed(3)} KD</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn" title={t.salesInvoices.editItem} onClick={() => openEdit(inv)}>
                      <IconEdit />
                    </button>
                    {inv.status === 'draft' && (
                      <button className="btn btn-secondary btn-sm" onClick={() => setStatus(inv, 'sent')}>
                        {t.salesInvoices.markSent}
                      </button>
                    )}
                    {(inv.status === 'sent' || inv.status === 'overdue') && (
                      <button className="btn btn-primary btn-sm" onClick={() => setStatus(inv, 'paid')}>
                        {t.salesInvoices.markPaid}
                      </button>
                    )}
                    {inv.status === 'draft' && (
                      <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(inv.id)}>
                        <IconTrash />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">{t.salesInvoices.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <FullScreenDoc
          title={editingId ? `${t.salesInvoices.editItem} — ${number}` : t.salesInvoices.newItem}
          onClose={() => setOpen(false)}
          actions={
            !isLocked ? (
              <button className="btn btn-primary btn-sm" type="submit" form="invoice-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
            ) : undefined
          }
        >
          <div className="doc-split">
            <form id="invoice-form" onSubmit={handleSubmit}>
              {isLocked && <div className="error-banner">{t.salesInvoices.lockedNotice}</div>}
              <div className="field">
                <label>{t.salesInvoices.customer}</label>
                <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={isLocked}>
                  <option value="">{t.salesInvoices.selectCustomer}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <div className="field">
                  <label>{t.salesInvoices.issueDate}</label>
                  <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} disabled={isLocked} />
                </div>
                <div className="field">
                  <label>{t.salesInvoices.dueDate}</label>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={isLocked} />
                </div>
              </div>
              <div className="field">
                <label>{t.salesInvoices.notes}</label>
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={isLocked} />
              </div>

              <div className="field">
                <label>{t.salesInvoices.items}</label>
                {rows.map((row, i) => (
                  <div key={i} className="doc-item-row">
                    <input
                      placeholder={t.salesInvoices.itemDescription}
                      value={row.description}
                      onChange={(e) => updateRow(i, { description: e.target.value })}
                      disabled={isLocked}
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      placeholder={t.salesInvoices.qty}
                      value={row.qty}
                      onChange={(e) => updateRow(i, { qty: e.target.value })}
                      disabled={isLocked}
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      placeholder={t.salesInvoices.unitPrice}
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
                    <IconPlus /> {t.salesInvoices.addItem}
                  </button>
                )}
              </div>
            </form>

            <DocumentPreview
              docTypeLabel={t.salesInvoices.docLabel}
              number={number || t.salesInvoices.numberPending}
              date={issueDate}
              dueDate={dueDate}
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
