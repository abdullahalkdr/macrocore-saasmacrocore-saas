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
interface TemplateItem {
  id: string;
  description: string;
  qty: number;
  unit_price: number;
}
interface Template {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  frequency: 'weekly' | 'monthly';
  next_run_date: string;
  active: boolean;
  notes: string | null;
}
interface ItemRow {
  description: string;
  qty: string;
  unitPrice: string;
}

function emptyRow(): ItemRow {
  return { description: '', qty: '1', unitPrice: '' };
}

export default function RecurringInvoicesPage() {
  const t = useT();
  const [items, setItems] = useState<Template[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [frequency, setFrequency] = useState<Template['frequency']>('monthly');
  const [nextRunDate, setNextRunDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<ItemRow[]>([emptyRow()]);

  function load() {
    get<{ templates: Template[] }>('/recurring-invoices')
      .then((r) => setItems(r.templates))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.recurringInvoices.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ customers: Customer[] }>('/customers').then((r) => setCustomers(r.customers)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetForm() {
    setCustomerId('');
    setFrequency('monthly');
    setNextRunDate(new Date().toISOString().slice(0, 10));
    setNotes('');
    setRows([emptyRow()]);
  }

  function openCreate() {
    resetForm();
    setEditingId(null);
    setOpen(true);
  }

  async function openEdit(tmpl: Template) {
    setError(null);
    try {
      const r = await get<{ template: Template; items: TemplateItem[] }>(`/recurring-invoices/${tmpl.id}`);
      setEditingId(tmpl.id);
      setCustomerId(r.template.customer_id || '');
      setFrequency(r.template.frequency);
      setNextRunDate(r.template.next_run_date.slice(0, 10));
      setNotes(r.template.notes || '');
      setRows(
        r.items.length > 0
          ? r.items.map((it) => ({ description: it.description, qty: String(it.qty), unitPrice: String(it.unit_price) }))
          : [emptyRow()]
      );
      setOpen(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.recurringInvoices.loadFailed);
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanItems = rows
      .filter((r) => r.description.trim() && Number(r.qty) > 0)
      .map((r) => ({ description: r.description.trim(), qty: Number(r.qty), unit_price: Number(r.unitPrice) || 0 }));
    if (cleanItems.length === 0) {
      setError(t.recurringInvoices.needItem);
      return;
    }
    setLoading(true);
    try {
      const payload = { customer_id: customerId || undefined, frequency, next_run_date: nextRunDate, notes: notes || undefined, items: cleanItems };
      if (editingId) {
        await patch(`/recurring-invoices/${editingId}`, payload);
      } else {
        await post('/recurring-invoices', payload);
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.recurringInvoices.updateFailed : t.recurringInvoices.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function toggleActive(tmpl: Template) {
    setError(null);
    try {
      await patch(`/recurring-invoices/${tmpl.id}`, { active: !tmpl.active });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.recurringInvoices.updateFailed);
    }
  }

  async function generateNow(tmpl: Template) {
    setError(null);
    try {
      const r = await post<{ invoice: { number: string } }>(`/recurring-invoices/${tmpl.id}/generate`);
      alert(`${t.recurringInvoices.generated}: ${r.invoice.number}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.recurringInvoices.generateFailed);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.recurringInvoices.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/recurring-invoices/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.recurringInvoices.deleteFailed);
    }
  }

  function frequencyLabel(f: Template['frequency']) {
    return t.recurringInvoices.frequencyValues[f];
  }

  const previewItems = rows.map((r) => ({ description: r.description, qty: Number(r.qty) || 0, unitPrice: Number(r.unitPrice) || 0 }));
  const customerName = customers.find((c) => c.id === customerId)?.name || '';

  return (
    <div>
      <PageHeader title={t.recurringInvoices.title} subtitle={t.recurringInvoices.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.recurringInvoices.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.recurringInvoices.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.recurringInvoices.customer}</th>
                <th>{t.recurringInvoices.frequency}</th>
                <th>{t.recurringInvoices.nextRun}</th>
                <th>{t.recurringInvoices.active}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((tmpl) => (
                <tr key={tmpl.id}>
                  <td style={{ fontWeight: 700 }}>{tmpl.customer_name || '—'}</td>
                  <td>{frequencyLabel(tmpl.frequency)}</td>
                  <td className="num">{tmpl.next_run_date.slice(0, 10)}</td>
                  <td>
                    <button type="button" className={`badge ${tmpl.active ? 'open' : 'closed'}`} style={{ border: 'none', cursor: 'pointer' }} onClick={() => toggleActive(tmpl)}>
                      {tmpl.active ? t.common.active : t.common.inactive}
                    </button>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => generateNow(tmpl)}>
                      {t.recurringInvoices.generateNow}
                    </button>
                    <button className="icon-btn" title={t.recurringInvoices.editItem} onClick={() => openEdit(tmpl)}>
                      <IconEdit />
                    </button>
                    <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(tmpl.id)}>
                      <IconTrash />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.recurringInvoices.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <FullScreenDoc
          title={editingId ? t.recurringInvoices.editItem : t.recurringInvoices.newItem}
          onClose={() => setOpen(false)}
          actions={
            <button className="btn btn-primary btn-sm" type="submit" form="recurring-form" disabled={loading}>
              {loading ? t.common.loading : t.common.save}
            </button>
          }
        >
          <div className="doc-split">
            <form id="recurring-form" onSubmit={handleSubmit}>
              <div className="field">
                <label>{t.recurringInvoices.customer}</label>
                <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">{t.recurringInvoices.selectCustomer}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <div className="field">
                  <label>{t.recurringInvoices.frequency}</label>
                  <select value={frequency} onChange={(e) => setFrequency(e.target.value as Template['frequency'])}>
                    <option value="weekly">{t.recurringInvoices.frequencyValues.weekly}</option>
                    <option value="monthly">{t.recurringInvoices.frequencyValues.monthly}</option>
                  </select>
                </div>
                <div className="field">
                  <label>{t.recurringInvoices.nextRun}</label>
                  <input type="date" value={nextRunDate} onChange={(e) => setNextRunDate(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label>{t.recurringInvoices.notes}</label>
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>

              <div className="field">
                <label>{t.recurringInvoices.items}</label>
                {rows.map((row, i) => (
                  <div key={i} className="doc-item-row">
                    <input placeholder={t.recurringInvoices.itemDescription} value={row.description} onChange={(e) => updateRow(i, { description: e.target.value })} />
                    <input type="number" min="0" step="0.001" placeholder={t.recurringInvoices.qty} value={row.qty} onChange={(e) => updateRow(i, { qty: e.target.value })} />
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      placeholder={t.recurringInvoices.unitPrice}
                      value={row.unitPrice}
                      onChange={(e) => updateRow(i, { unitPrice: e.target.value })}
                    />
                    <button type="button" className="icon-btn" title={t.common.delete} onClick={() => removeRow(i)}>
                      <IconTrash />
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
                  <IconPlus /> {t.recurringInvoices.addItem}
                </button>
              </div>
            </form>

            <DocumentPreview docTypeLabel={t.recurringInvoices.docLabel} number={frequencyLabel(frequency)} date={nextRunDate} customerName={customerName} items={previewItems} notes={notes} />
          </div>
        </FullScreenDoc>
      )}
    </div>
  );
}
