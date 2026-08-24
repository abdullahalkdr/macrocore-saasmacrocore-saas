import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import Modal from './Modal';

// Cost Centers module (MIGRATION_051). Same self-contained-modal shape as
// LocationModal.tsx (own fetch of the employees picker list, own submit
// handler posting straight to the API) rather than DepartmentsPage's
// store-backed form — cost centers have no tree/nested-resource complexity
// that would justify a dedicated store.
export interface CostCenter {
  id: string;
  code: string;
  name: string;
  description: string | null;
  manager_id: string | null;
  manager_name: string | null;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
}

interface EmployeeOption {
  id: string;
  name: string;
}

interface CostCenterModalProps {
  costCenter: CostCenter | null; // null => creating a new cost center
  onClose: () => void;
  onSaved: () => void;
}

export default function CostCenterModal({ costCenter, onClose, onSaved }: CostCenterModalProps) {
  const t = useT();

  const [code, setCode] = useState(costCenter?.code ?? '');
  const [name, setName] = useState(costCenter?.name ?? '');
  const [description, setDescription] = useState(costCenter?.description ?? '');
  const [managerId, setManagerId] = useState(costCenter?.manager_id ?? '');
  const [status, setStatus] = useState<'active' | 'inactive'>(costCenter?.status ?? 'active');

  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    get<{ employees: EmployeeOption[] }>('/employees')
      .then((r) => setEmployees(r.employees))
      .catch(() => {
        /* Manager dropdown just shows "no manager assigned" if this fails — not
           worth blocking the whole modal over the employee picker failing to load. */
      })
      .finally(() => setEmployeesLoading(false));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const payload = {
      code,
      name,
      description: description || undefined,
      manager_id: managerId || null,
      status,
    };
    try {
      if (costCenter) {
        await patch(`/cost-centers/${costCenter.id}`, payload);
      } else {
        await post('/cost-centers', payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.costCenters.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title={costCenter ? t.costCenters.editItem : t.costCenters.newItem}
      onClose={onClose}
      actions={(requestClose) => (
        <>
          <button className="btn btn-primary" type="submit" form="cost-center-form" disabled={loading}>
            {loading ? t.common.loading : t.common.save}
          </button>
          <button className="btn btn-secondary" type="button" onClick={requestClose}>
            {t.common.cancel}
          </button>
        </>
      )}
    >
      {error && (
        <div className="error-banner" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <form id="cost-center-form" onSubmit={handleSubmit} className="field-grid">
        <div className="field">
          <label>{t.costCenters.code}</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label>{t.costCenters.name}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label>{t.costCenters.manager}</label>
          <select value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={employeesLoading}>
            <option value="">{employeesLoading ? t.costCenters.managerLoading : t.costCenters.managerNone}</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{t.costCenters.status}</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}>
            <option value="active">{t.common.active}</option>
            <option value="inactive">{t.common.inactive}</option>
          </select>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>{t.costCenters.description}</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </div>
      </form>
    </Modal>
  );
}
