import { FormEvent, useEffect, useState } from 'react';
import { get, post, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus, IconTrash } from '../components/Icon';

interface Customer {
  id: string;
  name: string;
}
interface OpenInvoice {
  id: string;
  number: string;
  total: number;
  amount_paid: number;
}
interface Receipt {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  amount: number;
  receipt_date: string;
  method: 'cash' | 'bank_transfer' | 'card' | 'knet' | 'cheque' | 'other';
  notes: string | null;
}

export default function CustomerReceiptsPage() {
  const t = useT();
  const [items, setItems] = useState<Receipt[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [openInvoices, setOpenInvoices] = useState<OpenInvoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<Receipt['method']>('cash');
  const [notes, setNotes] = useState('');

  function load() {
    get<{ receipts: Receipt[] }>('/customer-receipts')
      .then((r) => setItems(r.receipts))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.customerReceipts.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ customers: Customer[] }>('/customers').then((r) => setCustomers(r.customers)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!customerId) {
      setOpenInvoices([]);
      setInvoiceId('');
      return;
    }
    get<{ invoices: OpenInvoice[] }>(`/customer-receipts/open-invoices/${customerId}`)
      .then((r) => setOpenInvoices(r.invoices))
      .catch(() => setOpenInvoices([]));
  }, [customerId]);

  function openCreate() {
    setCustomerId('');
    setInvoiceId('');
    setAmount('');
    setDate(new Date().toISOString().slice(0, 10));
    setMethod('cash');
    setNotes('');
    setOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!Number(amount) || Number(amount) <= 0) {
      setError(t.customerReceipts.needAmount);
      return;
    }
    setLoading(true);
    try {
      await post('/customer-receipts', {
        customer_id: customerId || undefined,
        invoice_id: invoiceId || undefined,
        amount: Number(amount),
        receipt_date: date,
        method,
        notes: notes || undefined,
      });
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.customerReceipts.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.customerReceipts.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/customer-receipts/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.customerReceipts.deleteFailed);
    }
  }

  function methodLabel(m: Receipt['method']) {
    return t.customerReceipts.methods[m] ?? m;
  }

  return (
    <div>
      <PageHeader title={t.customerReceipts.title} subtitle={t.customerReceipts.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.customerReceipts.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.customerReceipts.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.customerReceipts.customer}</th>
                <th>{t.customerReceipts.invoice}</th>
                <th>{t.customerReceipts.amount}</th>
                <th>{t.customerReceipts.date}</th>
                <th>{t.customerReceipts.method}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 700 }}>{r.customer_name || '—'}</td>
                  <td>{r.invoice_number || '—'}</td>
                  <td className="num">{r.amount.toFixed(3)} KD</td>
                  <td className="num">{r.receipt_date.slice(0, 10)}</td>
                  <td>
                    <span className="tag gray">{methodLabel(r.method)}</span>
                  </td>
                  <td>
                    <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(r.id)}>
                      <IconTrash />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">{t.customerReceipts.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.customerReceipts.newItem}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="receipt-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="receipt-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.customerReceipts.customer}</label>
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">{t.customerReceipts.selectCustomer}</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.customerReceipts.applyToInvoice}</label>
              <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} disabled={!customerId}>
                <option value="">{t.customerReceipts.noInvoice}</option>
                {openInvoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.number} — {(inv.total - inv.amount_paid).toFixed(3)} KD {t.customerReceipts.remaining}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.customerReceipts.amount}</label>
              <input type="number" min="0" step="0.001" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label>{t.customerReceipts.date}</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.customerReceipts.method}</label>
              <select value={method} onChange={(e) => setMethod(e.target.value as Receipt['method'])}>
                <option value="cash">{t.customerReceipts.methods.cash}</option>
                <option value="bank_transfer">{t.customerReceipts.methods.bank_transfer}</option>
                <option value="card">{t.customerReceipts.methods.card}</option>
                <option value="knet">{t.customerReceipts.methods.knet}</option>
                <option value="cheque">{t.customerReceipts.methods.cheque}</option>
                <option value="other">{t.customerReceipts.methods.other}</option>
              </select>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.customerReceipts.notes}</label>
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
