import { useEffect, useState } from 'react';
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
interface CashInvoiceItem {
  id: string;
  description: string;
  qty: number;
  unit_price: number;
  discount_pct: number;
}
interface CashInvoice {
  id: string;
  number: string;
  customer_id: string | null;
  customer_name: string | null;
  issue_date: string;
  status: 'draft' | 'paid' | 'cancelled';
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

// Cash invoices are usually paid on the spot, but per the Wafeq reference they can also
// be written up as a draft first ("حفظ كمسودة") and confirmed once payment is actually
// collected ("اعتماد") — see salesInvoices.controller.ts create()/update() for the
// backend side of this (type: 'cash' honors an explicit draft/paid status intent).
export default function CashInvoicesPage() {
  const t = useT();
  const company = useAuthStore((s) => s.company);
  const lang = useLangStore((s) => s.lang);
  const [items, setItems] = useState<CashInvoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [defaultNotes, setDefaultNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingStatus, setEditingStatus] = useState<CashInvoice['status']>('draft');
  const [customerId, setCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<ItemRow[]>([emptyRow()]);
  const [number, setNumber] = useState('');
  const [previewHidden, setPreviewHidden] = useState(false);

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

  function resetForm() {
    setCustomerId('');
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

  async function openEdit(inv: CashInvoice) {
    setError(null);
    try {
      const r = await get<{ invoice: CashInvoice; items: CashInvoiceItem[] }>(`/sales-invoices/${inv.id}`);
      setEditingId(inv.id);
      setEditingStatus(r.invoice.status);
      setCustomerId(r.invoice.customer_id || '');
      setIssueDate(r.invoice.issue_date ? r.invoice.issue_date.slice(0, 10) : '');
      setNotes(r.invoice.notes || '');
      setNumber(r.invoice.number);
      setRows(
        r.items.length > 0
          ? r.items.map((it) => ({ description: it.description, qty: String(it.qty), unitPrice: String(it.unit_price), discountPct: it.discount_pct ? String(it.discount_pct) : '' }))
          : [emptyRow()]
      );
      setOpen(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.cashInvoices.loadFailed);
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

  function buildItems() {
    return rows
      .filter((r) => r.description.trim() && Number(r.qty) > 0)
      .map((r) => ({ description: r.description.trim(), qty: Number(r.qty), unit_price: Number(r.unitPrice) || 0, discount_pct: Number(r.discountPct) || 0 }));
  }

  // Two distinct submit actions instead of one: "save as draft" writes it up without
  // marking it paid, "confirm" (اعتماد) marks it paid immediately (or in full, for an
  // already-drafted invoice — same endpoint, just a different status in the body).
  async function doSubmit(confirm: boolean) {
    setError(null);
    const cleanItems = buildItems();
    if (cleanItems.length === 0) {
      setError(t.cashInvoices.needItem);
      return;
    }
    setLoading(true);
    try {
      if (editingId) {
        await patch(`/sales-invoices/${editingId}`, {
          customer_id: customerId || undefined,
          issue_date: issueDate || undefined,
          notes: notes || undefined,
          items: cleanItems,
          ...(confirm ? { status: 'paid' } : {}),
        });
      } else {
        await post('/sales-invoices', {
          type: 'cash',
          customer_id: customerId || undefined,
          issue_date: issueDate,
          notes: notes || undefined,
          items: cleanItems,
          status: confirm ? 'paid' : 'draft',
        });
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.cashInvoices.updateFailed : t.cashInvoices.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.cashInvoices.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/sales-invoices/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.cashInvoices.deleteFailed);
    }
  }

  function statusLabel(s: CashInvoice['status']) {
    return t.cashInvoices.status[s];
  }
  function statusBadgeClass(s: CashInvoice['status']) {
    if (s === 'paid') return 'open';
    if (s === 'cancelled') return 'cancelled';
    return 'closed';
  }

  const previewItems = rows.map((r) => ({ description: r.description, qty: Number(r.qty) || 0, unitPrice: Number(r.unitPrice) || 0, discountPct: Number(r.discountPct) || 0 }));
  const customerName = customers.find((c) => c.id === customerId)?.name || '';

  function printInvoice(inv: CashInvoice, invItems: CashInvoiceItem[]) {
    printDocument({
      companyName: company?.name || 'macrocore',
      docTypeLabel: t.cashInvoices.docLabel,
      number: inv.number,
      date: inv.issue_date ? inv.issue_date.slice(0, 10) : '',
      customerName: inv.customer_name || '',
      items: invItems.map((it) => ({ description: it.description, qty: it.qty, unitPrice: it.unit_price, discountPct: it.discount_pct })),
      notes: inv.notes,
      statusLabel: statusLabel(inv.status),
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

  async function handlePrint(inv: CashInvoice) {
    setError(null);
    try {
      const r = await get<{ invoice: CashInvoice; items: CashInvoiceItem[] }>(`/sales-invoices/${inv.id}`);
      printInvoice(r.invoice, r.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.cashInvoices.loadFailed);
    }
  }

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
                <th>{t.cashInvoices.status.label}</th>
                <th>{t.cashInvoices.total}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((inv) => (
                <tr key={inv.id}>
                  <td style={{ fontWeight: 700 }}>{inv.number}</td>
                  <td>{inv.customer_name || '—'}</td>
                  <td className="num">{inv.issue_date.slice(0, 10)}</td>
                  <td>
                    <span className={`badge ${statusBadgeClass(inv.status)}`}>{statusLabel(inv.status)}</span>
                  </td>
                  <td className="num">{inv.total.toFixed(3)} KD</td>
                  <td className="row-hover-actions" style={{ whiteSpace: 'nowrap' }}>
                    <button className="icon-btn print-btn" title={t.salesDocs.print} onClick={() => handlePrint(inv)}>
                      <IconPrinter />
                    </button>
                    <button className="icon-btn" title={t.salesInvoices.editItem} onClick={() => openEdit(inv)}>
                      <IconEdit />
                    </button>
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
                  <td colSpan={6}>
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
          title={editingId ? `${t.salesInvoices.editItem} — ${number}` : t.cashInvoices.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPreviewHidden((v) => !v)}>
                {previewHidden ? <IconEye /> : <IconEyeOff />} {previewHidden ? t.salesDocs.showPreview : t.salesDocs.hidePreview}
              </button>
              {!isLocked && (
                <>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => doSubmit(false)} disabled={loading}>
                    {loading ? t.common.loading : t.cashInvoices.saveDraft}
                  </button>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => doSubmit(true)} disabled={loading}>
                    {loading ? t.common.loading : t.cashInvoices.confirm}
                  </button>
                </>
              )}
            </>
          }
        >
          <div className={`doc-split${previewHidden ? ' preview-hidden' : ''}`}>
            <form
              id="cash-invoice-form"
              onSubmit={(e) => {
                e.preventDefault();
                doSubmit(false);
              }}
            >
              {isLocked && <div className="error-banner">{t.salesInvoices.lockedNotice}</div>}
              <div className="field">
                <label>{t.cashInvoices.customer}</label>
                <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={isLocked}>
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
                <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} disabled={isLocked} />
              </div>
              <div className="field">
                <label>{t.cashInvoices.notes}</label>
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={isLocked} />
              </div>

              <div className="field">
                <label>{t.cashInvoices.items}</label>
                {rows.map((row, i) => (
                  <div key={i} className="doc-item-row">
                    <input placeholder={t.cashInvoices.itemDescription} value={row.description} onChange={(e) => updateRow(i, { description: e.target.value })} disabled={isLocked} />
                    <input type="number" min="0" step="0.001" placeholder={t.cashInvoices.qty} value={row.qty} onChange={(e) => updateRow(i, { qty: e.target.value })} disabled={isLocked} />
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      placeholder={t.cashInvoices.unitPrice}
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
                    <IconPlus /> {t.cashInvoices.addItem}
                  </button>
                )}
              </div>
            </form>

            <DocumentPreview
              docTypeLabel={t.cashInvoices.docLabel}
              number={number || t.cashInvoices.numberPending}
              date={issueDate}
              customerName={customerName}
              items={previewItems}
              notes={notes}
              statusLabel={editingId ? statusLabel(editingStatus) : statusLabel('draft')}
              statusVariant={editingStatus === 'paid' ? 'paid' : 'draft'}
            />
          </div>
        </FullScreenDoc>
      )}
    </div>
  );
}
