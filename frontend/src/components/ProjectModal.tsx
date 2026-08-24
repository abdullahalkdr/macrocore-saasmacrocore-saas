import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import Modal from './Modal';

// Projects module (MIGRATION_052). Same self-contained-modal shape as
// CostCenterModal.tsx (own fetch of the employees + cost centers picker
// lists, own submit handler posting straight to the API).
export interface Project {
  id: string;
  code: string;
  name: string;
  description: string | null;
  manager_id: string | null;
  manager_name: string | null;
  cost_center_id: string | null;
  cost_center_code: string | null;
  cost_center_name: string | null;
  start_date: string;
  end_date: string | null;
  budget: number;
  status: 'active' | 'completed' | 'on_hold' | 'cancelled';
  created_at: string;
  updated_at: string;
}

interface EmployeeOption {
  id: string;
  name: string;
}

interface CostCenterOption {
  id: string;
  code: string;
  name: string;
}

interface ProjectModalProps {
  project: Project | null; // null => creating a new project
  onClose: () => void;
  onSaved: () => void;
}

const STATUS_OPTIONS = ['active', 'completed', 'on_hold', 'cancelled'] as const;

export default function ProjectModal({ project, onClose, onSaved }: ProjectModalProps) {
  const t = useT();

  const STATUS_LABELS: Record<string, string> = {
    active: t.projects.statusActive,
    completed: t.projects.statusCompleted,
    on_hold: t.projects.statusOnHold,
    cancelled: t.projects.statusCancelled,
  };

  const [code, setCode] = useState(project?.code ?? '');
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [managerId, setManagerId] = useState(project?.manager_id ?? '');
  const [costCenterId, setCostCenterId] = useState(project?.cost_center_id ?? '');
  const [startDate, setStartDate] = useState(project?.start_date?.slice(0, 10) ?? '');
  const [endDate, setEndDate] = useState(project?.end_date?.slice(0, 10) ?? '');
  const [budget, setBudget] = useState(project ? String(project.budget) : '0');
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>(project?.status ?? 'active');

  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [costCenters, setCostCenters] = useState<CostCenterOption[]>([]);
  const [costCentersLoading, setCostCentersLoading] = useState(true);
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
    get<{ costCenters: CostCenterOption[] }>('/cost-centers')
      .then((r) => setCostCenters(r.costCenters))
      .catch(() => {
        /* Same reasoning — cost center picker just shows "none" if this fails. */
      })
      .finally(() => setCostCentersLoading(false));
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
      cost_center_id: costCenterId || null,
      start_date: startDate,
      end_date: endDate || null,
      budget: Number(budget) || 0,
      status,
    };
    try {
      if (project) {
        await patch(`/projects/${project.id}`, payload);
      } else {
        await post('/projects', payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.projects.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title={project ? t.projects.editItem : t.projects.newItem}
      onClose={onClose}
      actions={(requestClose) => (
        <>
          <button className="btn btn-primary" type="submit" form="project-form" disabled={loading}>
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

      <form id="project-form" onSubmit={handleSubmit} className="field-grid">
        <div className="field">
          <label>{t.projects.code}</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label>{t.projects.name}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label>{t.projects.costCenter}</label>
          <select value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)} disabled={costCentersLoading}>
            <option value="">{costCentersLoading ? t.projects.costCenterLoading : t.projects.costCenterNone}</option>
            {costCenters.map((cc) => (
              <option key={cc.id} value={cc.id}>
                {cc.code} — {cc.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{t.projects.manager}</label>
          <select value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={employeesLoading}>
            <option value="">{employeesLoading ? t.projects.managerLoading : t.projects.managerNone}</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{t.projects.startDate}</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </div>
        <div className="field">
          <label>{t.projects.endDate}</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div className="field">
          <label>{t.projects.budget}</label>
          <input type="number" step="0.001" min={0} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>
        <div className="field">
          <label>{t.projects.status}</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUS_OPTIONS)[number])}>
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {STATUS_LABELS[opt]}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>{t.projects.description}</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </div>
      </form>
    </Modal>
  );
}
