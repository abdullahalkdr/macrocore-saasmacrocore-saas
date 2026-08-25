import { FormEvent, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import ApprovalWorkflowModal from '../components/ApprovalWorkflowModal';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

interface Supplier {
  id: string;
  name: string;
}
interface Location {
  id: string;
  name: string;
}
interface RawMaterial {
  id: string;
  name: string;
  name_en: string | null;
}
interface POItem {
  id: string;
  raw_material_id: string;
  raw_material_name: string;
  raw_material_name_en: string | null;
  qty: number;
  unit_price: number;
}
interface PurchaseOrder {
  id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  status: 'draft' | 'ordered' | 'received' | 'cancelled';
  order_date: string | null;
  expected_date: string | null;
  received_date: string | null;
  location_id: string | null;
  location_name: string | null;
  notes: string | null;
  created_at: string;
  total: number;
  // MIGRATION_058 — latest approval_requests status for this PO's PURCHASE_ORDER
  // module_type, or null if never submitted (below-Gold company, or a draft that
  // hasn't hit "Send to Supplier" yet).
  approval_status?: 'pending' | 'approved' | 'rejected' | null;
}
interface ItemRow {
  rawMaterialId: string;
  qty: string;
  unitPrice: string;
}

function emptyRow(): ItemRow {
  return { rawMaterialId: '', qty: '', unitPrice: '' };
}

export default function PurchaseOrdersPage() {
  const t = useT();
  const [items, setItems] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [orderDate, setOrderDate] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<ItemRow[]>([emptyRow()]);

  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrder | null>(null);
  const [receiveLocationId, setReceiveLocationId] = useState('');

  // Approval status popup (ApprovalWorkflowModal.tsx) — opened by clicking the
  // pending/rejected approval tag on a row; read-only, open to anyone.
  const [approvalView, setApprovalView] = useState<PurchaseOrder | null>(null);

  function load() {
    get<{ purchase_orders: PurchaseOrder[] }>('/purchase-orders')
      .then((r) => setItems(r.purchase_orders))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.purchaseOrders.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ suppliers: Supplier[] }>('/suppliers').then((r) => setSuppliers(r.suppliers)).catch(() => {});
    get<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
    get<{ raw_materials: RawMaterial[] }>('/raw-materials').then((r) => setRawMaterials(r.raw_materials)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "View Details" deep-link from ApprovalsInboxPage.tsx: /purchase-orders?record=<id>
  // opens that PO's edit modal once the list has loaded — same pattern
  // SupportTicketsPage.tsx uses for /support?ticket=. openEdit is a function
  // declaration further down, hoisted within this component's scope.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const recordId = searchParams.get('record');
    if (!recordId) return;
    const match = items.find((po) => po.id === recordId);
    if (match) openEdit(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  function resetForm() {
    setSupplierId('');
    setOrderDate('');
    setExpectedDate('');
    setNotes('');
    setRows([emptyRow()]);
  }

  function openCreate() {
    resetForm();
    setEditingId(null);
    setOpen(true);
  }

  async function openEdit(po: PurchaseOrder) {
    setError(null);
    try {
      const r = await get<{ purchase_order: PurchaseOrder; items: POItem[] }>(`/purchase-orders/${po.id}`);
      setEditingId(po.id);
      setSupplierId(r.purchase_order.supplier_id || '');
      setOrderDate(r.purchase_order.order_date ? r.purchase_order.order_date.slice(0, 10) : '');
      setExpectedDate(r.purchase_order.expected_date ? r.purchase_order.expected_date.slice(0, 10) : '');
      setNotes(r.purchase_order.notes || '');
      setRows(
        r.items.length > 0
          ? r.items.map((it) => ({ rawMaterialId: it.raw_material_id, qty: String(it.qty), unitPrice: String(it.unit_price) }))
          : [emptyRow()]
      );
      setOpen(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.purchaseOrders.loadFailed);
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

  const formTotal = rows.reduce((sum, r) => sum + (Number(r.qty) || 0) * (Number(r.unitPrice) || 0), 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanItems = rows
      .filter((r) => r.rawMaterialId && Number(r.qty) > 0)
      .map((r) => ({ raw_material_id: r.rawMaterialId, qty: Number(r.qty), unit_price: Number(r.unitPrice) || 0 }));
    if (cleanItems.length === 0) {
      setError(t.purchaseOrders.needItem);
      return;
    }
    setLoading(true);
    try {
      const payload = {
        supplier_id: supplierId || undefined,
        order_date: orderDate || undefined,
        expected_date: expectedDate || undefined,
        notes: notes || undefined,
        items: cleanItems,
      };
      if (editingId) {
        await patch(`/purchase-orders/${editingId}`, payload);
      } else {
        await post('/purchase-orders', payload);
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.purchaseOrders.updateFailed : t.purchaseOrders.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function markOrdered(po: PurchaseOrder) {
    setError(null);
    try {
      await patch(`/purchase-orders/${po.id}`, { status: 'ordered' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.purchaseOrders.updateFailed);
    }
  }

  async function cancelOrder(po: PurchaseOrder) {
    if (!confirm(t.purchaseOrders.cancelConfirm)) return;
    setError(null);
    try {
      await patch(`/purchase-orders/${po.id}`, { status: 'cancelled' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.purchaseOrders.updateFailed);
    }
  }

  function openReceive(po: PurchaseOrder) {
    setReceiveTarget(po);
    setReceiveLocationId(po.location_id || '');
  }

  async function confirmReceive(e: FormEvent) {
    e.preventDefault();
    if (!receiveTarget) return;
    setError(null);
    setLoading(true);
    try {
      await post(`/purchase-orders/${receiveTarget.id}/receive`, { location_id: receiveLocationId });
      setReceiveTarget(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.purchaseOrders.receiveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.purchaseOrders.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/purchase-orders/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.purchaseOrders.deleteFailed);
    }
  }

  // MIGRATION_058 — the PO currently open in the edit modal is locked (Save
  // disabled) while its own "Send to Supplier" submission is awaiting approval.
  const editingRecordPending = !!editingId && items.find((po) => po.id === editingId)?.approval_status === 'pending';

  function statusLabel(s: PurchaseOrder['status']) {
    return t.purchaseOrders.status[s];
  }

  function rawMaterialLabel(m: RawMaterial) {
    return m.name || m.name_en || '';
  }

  function poDetailLines(po: PurchaseOrder): { label: string; value: string }[] {
    const lines = [
      { label: t.purchaseOrders.supplier, value: po.supplier_name || '—' },
      { label: t.purchaseOrders.status.label, value: statusLabel(po.status) },
      { label: t.purchaseOrders.total, value: `${po.total.toFixed(3)} KD` },
    ];
    if (po.order_date) lines.push({ label: t.purchaseOrders.orderDate, value: po.order_date.slice(0, 10) });
    if (po.expected_date) lines.push({ label: t.purchaseOrders.expectedDate, value: po.expected_date.slice(0, 10) });
    if (po.notes) lines.push({ label: t.purchaseOrders.notes, value: po.notes });
    return lines;
  }

  return (
    <div>
      <PageHeader title={t.purchaseOrders.title} subtitle={t.purchaseOrders.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.purchaseOrders.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.purchaseOrders.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.purchaseOrders.supplier}</th>
                <th>{t.purchaseOrders.status.label}</th>
                <th>{t.purchaseOrders.orderDate}</th>
                <th>{t.purchaseOrders.expectedDate}</th>
                <th>{t.purchaseOrders.total}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((po) => (
                <tr key={po.id}>
                  <td style={{ fontWeight: 700 }}>{po.supplier_name || '—'}</td>
                  <td>
                    <span className={`badge ${po.status}`}>{statusLabel(po.status)}</span>
                    {(po.approval_status === 'pending' || po.approval_status === 'rejected') && (
                      <div style={{ marginTop: 4 }}>
                        <button
                          type="button"
                          className="link-button"
                          style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                          onClick={() => setApprovalView(po)}
                          title={t.approvalWorkflow.title}
                        >
                          {po.approval_status === 'pending' ? (
                            <Tag color="amber">{t.purchaseOrders.pendingApproval}</Tag>
                          ) : (
                            <Tag color="red">{t.purchaseOrders.rejectedStatus}</Tag>
                          )}
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="num">{po.order_date ? po.order_date.slice(0, 10) : '—'}</td>
                  <td className="num">{po.expected_date ? po.expected_date.slice(0, 10) : '—'}</td>
                  <td className="num">{po.total.toFixed(3)} KD</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {/* MIGRATION_058 — a draft awaiting approval to be sent locks out
                        Edit/Send to Supplier/Delete entirely (prevent tampering while
                        pending, per spec) instead of just disabling them. */}
                    {po.status === 'draft' && po.approval_status === 'pending' && (
                      <span className="muted" style={{ fontSize: 12 }}>{t.purchaseOrders.submittedForApproval}</span>
                    )}
                    {po.status === 'draft' && po.approval_status !== 'pending' && (
                      <>
                        <button className="icon-btn" title={t.purchaseOrders.editItem} onClick={() => openEdit(po)}>
                          <IconEdit />
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => markOrdered(po)}>
                          {t.purchaseOrders.markOrdered}
                        </button>
                        <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(po.id)}>
                          <IconTrash />
                        </button>
                      </>
                    )}
                    {po.status === 'ordered' && (
                      <>
                        <button className="btn btn-primary btn-sm" onClick={() => openReceive(po)}>
                          {t.purchaseOrders.receive}
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => cancelOrder(po)}>
                          {t.purchaseOrders.cancel}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">{t.purchaseOrders.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? t.purchaseOrders.editItem : t.purchaseOrders.newItem}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="po-form" disabled={loading || editingRecordPending}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          {editingRecordPending && <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{t.purchaseOrders.submittedForApproval}</p>}
          <form id="po-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.purchaseOrders.supplier}</label>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">{t.purchaseOrders.selectSupplier}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.purchaseOrders.orderDate}</label>
              <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.purchaseOrders.expectedDate}</label>
              <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.purchaseOrders.notes}</label>
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.purchaseOrders.items}</label>
              {rows.map((row, i) => (
                <div key={i} className="form-row" style={{ marginBottom: 6 }}>
                  <select
                    value={row.rawMaterialId}
                    onChange={(e) => updateRow(i, { rawMaterialId: e.target.value })}
                    style={{ flex: 2 }}
                  >
                    <option value="">{t.purchaseOrders.selectMaterial}</option>
                    {rawMaterials.map((m) => (
                      <option key={m.id} value={m.id}>
                        {rawMaterialLabel(m)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    placeholder={t.purchaseOrders.qty}
                    value={row.qty}
                    onChange={(e) => updateRow(i, { qty: e.target.value })}
                    style={{ flex: 1 }}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    placeholder={t.purchaseOrders.unitPrice}
                    value={row.unitPrice}
                    onChange={(e) => updateRow(i, { unitPrice: e.target.value })}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="icon-btn" title={t.common.delete} onClick={() => removeRow(i)}>
                    <IconTrash />
                  </button>
                </div>
              ))}
              <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
                <IconPlus /> {t.purchaseOrders.addItem}
              </button>
              <div className="muted" style={{ marginTop: 8 }}>
                {t.purchaseOrders.total}: {formTotal.toFixed(3)} KD
              </div>
            </div>
          </form>
        </Modal>
      )}

      {receiveTarget && (
        <Modal
          title={t.purchaseOrders.receive}
          onClose={() => setReceiveTarget(null)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="po-receive-form" disabled={loading}>
                {loading ? t.common.loading : t.purchaseOrders.confirmReceive}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="po-receive-form" onSubmit={confirmReceive} className="field-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.purchaseOrders.receiveLocationHint}</label>
              <select value={receiveLocationId} onChange={(e) => setReceiveLocationId(e.target.value)} required>
                <option value="">{t.purchaseOrders.selectLocation}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </form>
        </Modal>
      )}

      {approvalView && (
        <ApprovalWorkflowModal
          moduleType="PURCHASE_ORDER"
          referenceId={approvalView.id}
          detailLines={poDetailLines(approvalView)}
          onClose={() => setApprovalView(null)}
          onActioned={load}
        />
      )}
    </div>
  );
}
