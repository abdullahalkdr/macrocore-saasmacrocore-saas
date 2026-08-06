import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useAuthStore } from '../store/authStore';
import { useLangStore, isRTL } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import FullScreenDoc from '../components/FullScreenDoc';
import DocumentPreview from '../components/DocumentPreview';
import { IconPlus, IconEdit, IconTrash, IconEye, IconEyeOff, IconPrinter } from '../components/Icon';
import { printDocument } from '../utils/printDocument';

interface Customer {
  id: string;
  name: string;
}
interface InvoiceOption {
  id: string;
  number: string;
  customer_id: string | null;
}
interface CreditNoteItem {
  id: string;
  description: string;
  qty: number;
  unit_price: number;
  discount_pct: number;
}
interface CreditNote {
  id: string;
  number: string;
  customer_id: string | null;
  customer_name: string | null;
  source_invoice_id: string | null;
  source_invoice_number: string | null;
  issue_date: string;
  status: 'draft' | 'issued';
  notes: string | null;
  total: number;
}
interface ItemRow {
  description: string;
  qty: string;
  unitPrice: string;
  discountPct: string;
}

function emptyRow(): ItemRow {
  return { description: '', qty: '1', unitPrice: '', discountPct: '' };
}

export default function CreditNotesPage() {
  const t = useT();
  const company = useAuthStore((s) => s.company);
  const lang = useLangStore((s) => s.lang);
  const [items, setItems] = useState<CreditNote[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [defaultNotes, setDefaultNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingStatus, setEditingStatus] = useState<CreditNote['status']>('draft');
  const [customerId, setCustomerId] = useState('');
  const [sourceInvoiceId, setSourceInvoiceId] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<ItemRow[]>([emptyRow()]);
  const [number, setNumber] = useState('');
  const [previewHidden, setPreviewHidden] = useState(false);

  function load() {
    get<{ credit_notes: CreditNote[] }>('/credit-notes')
      .then((r) => setItems(r.credit_notes))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.creditNotes.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ customers: Customer[] }>('/customers').then((r) => setCustomers(r.customers)).catch(() => {});
    get<{ invoices: InvoiceOption[] }>('/sales-invoices').then((r) => setInvoices(r.invoices)).catch(() => {});
    get<{ default_sales_notes: string | null }>('/company/me').then((r) => setDefaultNotes(r.default_sales_notes || '')).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetForm() {
    setCustomerId('');
    setSourceInvoiceId('');
    setIssueDate(new Date().toISOString().slice(0, 10));
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

  async function openEdit(n: CreditNote) {
    setError(null);
    try {
      const r = await get<{ credit_note: CreditNote; items: CreditNoteItem[] }>(`/credit-notes/${n.id}`);
      setEditingId(n.id);
      setEditingStatus(r.credit_note.status);
      setCustomerId(r.credit_note.customer_id || '');
      setSourceInvoiceId(r.credit_note.source_invoice_id || '');
      setIssueDate(r.credit_note.issue_date.slice(0, 10));
      setNotes(r.credit_note.notes || '');
      setNumber(r.credit_note.number);
      setRows(
        r.items.length > 0
          ? r.items.map((it) => ({ description: it.description, qty: String(it.qty), unitPrice: String(it.unit_price), discountPct: it.discount_pct ? String(it.discount_pct) : '' }))
          : [emptyRow()]
      );
      setOpen(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.creditNotes.loadFailed);
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
      .map((r) => ({ description: r.description.trim(), qty: Number(r.qty), unit_price: Number(r.unitPrice) || 0, discount_pct: Number(r.discountPct) || 0 }));
    if (cleanItems.length === 0) {
      setError(t.creditNotes.needItem);
      return;
    }
    setLoading(true);
    try {
      const payload = {
        customer_id: customerId || undefined,
        source_invoice_id: sourceInvoiceId || undefined,
        issue_date: issueDate || undefined,
        notes: notes || undefined,
        items: cleanItems,
      };
      if (editingId) {
        await patch(`/credit-notes/${editingId}`, payload);
      } else {
        await post('/credit-notes', payload);
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.creditNotes.updateFailed : t.creditNotes.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function markIssued(n: CreditNote) {
    setError(null);
    try {
      await patch(`/credit-notes/${n.id}`, { status: 'issued' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.creditNotes.updateFailed);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.creditNotes.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/credit-notes/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.creditNotes.deleteFailed);
    }
  }

  const previewItems = rows.map((r) => ({ description: r.description, qty: Number(r.qty) || 0, unitPrice: Number(r.unitPrice) || 0, discountPct: Number(r.discountPct) || 0 }));
  const customerName = customers.find((c) => c.id === customerId)?.name || '';
  const invoiceOptions = invoices.filter((inv) => !customerId || inv.customer_id === customerId);

  function printCreditNote(n: CreditNote, nItems: CreditNoteItem[]) {
    printDocument({
      companyName: company?.name || 'macrocore',
      docTypeLabel: t.creditNotes.docLabel,
      number: n.number,
      date: n.issue_date ? n.issue_date.slice(0, 10) : '',
      customerName: n.customer_name || '',
      items: nItems.map((it) => ({ description: it.description, qty: it.qty, unitPrice: it.unit_price, discountPct: it.discount_pct })),
      notes: n.notes,
      statusLabel: t.creditNotes.status[n.status],
      labels: {
        billTo: t.salesDocs.billTo,
        description: t.salesDocs.description,
        qty: t.salesDocs.qty,
        unitPrice: t.salesDocs.unitPrice,
        discount: t.salesDocs.discount,
        lineTotal: t.salesDocs.lineTotal,
        subtotal: t.salesDocs.subtotal,
        total: t.salesDocs.total,
        notes: t.salesDocs.notes,
        due: t.salesDocs.due,
      },
      dir: isRTL(lang) ? 'rtl' : 'ltr',
      lang,
    });
  }

  async function handlePrint(n: CreditNote) {
    setError(null);
    try {
      const r = await get<{ credit_note: CreditNote; items: CreditNoteItem[] }>(`/credit-notes/${n.id}`);
      printCreditNote(r.credit_note, r.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.creditNotes.loadFailed);
    }
  }

  return (
    <div>
      <PageHeader title={t.creditNotes.title} subtitle={t.creditNotes.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.creditNotes.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.creditNotes.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.creditNotes.number}</th>
                <th>{t.creditNotes.customer}</th>
                <th>{t.creditNotes.sourceInvoice}</th>
                <th>{t.creditNotes.issueDate}</th>
                <th>{t.creditNotes.status.label}</th>
                <th>{t.creditNotes.total}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((n) => (
                <tr key={n.id}>
                  <td style={{ fontWeight: 700 }}>{n.number}</td>
                  <td>{n.customer_name || '—'}</td>
                  <td>{n.source_invoice_number || '—'}</td>
                  <td className="num">{n.issue_date.slice(0, 10)}</td>
                  <td>
                    <span className={`badge ${n.status === 'draft' ? 'closed' : 'open'}`}>{t.creditNotes.status[n.status]}</span>
                  </td>
                  <td className="num">{n.total.toFixed(3)} KD</td>
                  <td className="row-hover-actions" style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn print-btn" title={t.salesDocs.print} onClick={() => handlePrint(n)}>
                      <IconPrinter />
                    </button>
                    <button className="icon-btn" title={t.creditNotes.editItem} onClick={() => openEdit(n)}>
                      <IconEdit />
                    </button>
                    {n.status === 'draft' && (
                      <>
                        <button className="btn btn-secondary btn-sm" onClick={() => markIssued(n)}>
                          {t.creditNotes.markIssued}
                        </button>
                        <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(n.id)}>
                          <IconTrash />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">{t.creditNotes.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <FullScreenDoc
          title={editingId ? `${t.creditNotes.editItem} — ${number}` : t.creditNotes.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPreviewHidden((v) => !v)}>
                {previewHidden ? <IconEye /> : <IconEyeOff />} {previewHidden ? t.salesDocs.showPreview : t.salesDocs.hidePreview}
              </button>
              {!isLocked && (
                <button className="btn btn-primary btn-sm" type="submit" form="credit-note-form" disabled={loading}>
                  {loading ? t.common.loading : t.common.save}
                </button>
              )}
            </>
          }
        >
          <div className={`doc-split${previewHidden ? ' preview-hidden' : ''}`}>
            <form id="credit-note-form" onSubmit={handleSubmit}>
              {isLocked && <div className="error-banner">{t.creditNotes.lockedNotice}</div>}
              <div className="field">
                <label>{t.creditNotes.customer}</label>
                <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setSourceInvoiceId(''); }} disabled={isLocked}>
                  <option value="">{t.creditNotes.selectCustomer}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>{t.creditNotes.sourceInvoice}</label>
                <select value={sourceInvoiceId} onChange={(e) => setSourceInvoiceId(e.target.value)} disabled={isLocked}>
                  <option value="">{t.creditNotes.noSourceInvoice}</option>
                  {invoiceOptions.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.number}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>{t.creditNotes.issueDate}</label>
                <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} disabled={isLocked} />
              </div>
              <div className="field">
                <label>{t.creditNotes.notes}</label>
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={isLocked} />
              </div>

              <div className="field">
                <label>{t.creditNotes.items}</label>
                {rows.map((row, i) => (
                  <div key={i} className="doc-item-row">
                    <input placeholder={t.creditNotes.itemDescription} value={row.description} onChange={(e) => updateRow(i, { description: e.target.value })} disabled={isLocked} />
                    <input type="number" min="0" step="0.001" placeholder={t.creditNotes.qty} value={row.qty} onChange={(e) => updateRow(i, { qty: e.target.value })} disabled={isLocked} />
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      placeholder={t.creditNotes.unitPrice}
                      value={row.unitPrice}
                      onChange={(e) => updateRow(i, { unitPrice: e.target.value })}
                      disabled={isLocked}
                    />
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      placeholder={t.salesDocs.discount}
                      value={row.discountPct}
                      onChange={(e) => updateRow(i, { discountPct: e.target.value })}
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
                    <IconPlus /> {t.creditNotes.addItem}
                  </button>
                )}
              </div>
            </form>

            <DocumentPreview
              docTypeLabel={t.creditNotes.docLabel}
              number={number || t.creditNotes.numberPending}
              date={issueDate}
              customerName={customerName}
              items={previewItems}
              notes={notes}
              statusLabel={editingId ? t.creditNotes.status[editingStatus] : undefined}
              statusVariant={editingStatus === 'issued' ? 'paid' : 'draft'}
            />
          </div>
        </FullScreenDoc>
      )}
    </div>
  );
}
