import { FormEvent, Fragment, useEffect, useState } from 'react';
import { get, post, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import { IconPlus } from '../components/Icon';

interface PayrollRecord {
  id: string;
  employee_id: string;
  month_year: string;
  base_salary: number;
  attendance_bonus: number;
  other_deductions: number;
  wage_type: 'monthly' | 'hourly';
  hourly_rate: number | null;
  hours_worked: number | null;
  attendance_deduction: number;
  total_paid: number;
  paid_date: string | null;
}
interface Employee {
  id: string;
  name: string;
  wage_type: 'monthly' | 'hourly';
}

interface Adjustment {
  type: 'bonus' | 'deduction';
  label: string;
  amount: string; // kept as string while editing in the form
}

function monthStr() {
  return new Date().toISOString().slice(0, 7);
}

export default function PayrollPage() {
  const t = useT();
  const [items, setItems] = useState<PayrollRecord[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [monthYear, setMonthYear] = useState(monthStr());
  const [bonus, setBonus] = useState('');
  const [deductions, setDeductions] = useState('');
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function load() {
    get<{ payroll: PayrollRecord[] }>('/payroll')
      .then((r) => setItems(r.payroll))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.payroll.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const employeeName = (id: string) => employees.find((e) => e.id === id)?.name || id;
  const selectedEmployee = employees.find((e) => e.id === employeeId);

  function addAdjustment() {
    setAdjustments((a) => [...a, { type: 'bonus', label: '', amount: '' }]);
  }
  function updateAdjustment(i: number, patch: Partial<Adjustment>) {
    setAdjustments((a) => a.map((adj, idx) => (idx === i ? { ...adj, ...patch } : adj)));
  }
  function removeAdjustment(i: number) {
    setAdjustments((a) => a.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const validAdjustments = adjustments
        .filter((a) => a.label.trim() && a.amount)
        .map((a) => ({ type: a.type, label: a.label.trim(), amount: Number(a.amount) }));

      await post('/payroll', {
        employee_id: employeeId,
        month_year: monthYear,
        attendance_bonus: bonus ? Number(bonus) : undefined,
        other_deductions: deductions ? Number(deductions) : undefined,
        adjustments: validAdjustments,
      });
      setBonus('');
      setDeductions('');
      setAdjustments([]);
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.payroll.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function markPaid(id: string) {
    setError(null);
    try {
      await post(`/payroll/${id}/pay`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.payroll.payFailed);
    }
  }

  return (
    <div>
      <PageHeader title={t.payroll.title} subtitle={t.payroll.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.payroll.count(items.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          <IconPlus /> {t.payroll.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.payroll.employee}</th>
                <th>{t.payroll.month}</th>
                <th>نظام الأجر</th>
                <th className="num">{t.payroll.base}</th>
                <th className="num">خصم التأخير</th>
                <th className="num">الصافي</th>
                <th>{t.payroll.status}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <Fragment key={p.id}>
                  <tr style={{ cursor: 'pointer' }} onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}>
                    <td style={{ fontWeight: 700 }}>{employeeName(p.employee_id)}</td>
                    <td>{p.month_year}</td>
                    <td>
                      {p.wage_type === 'hourly'
                        ? `بالساعة${p.hours_worked !== null ? ` (${Number(p.hours_worked).toFixed(1)} ساعة)` : ''}`
                        : 'شهري'}
                    </td>
                    <td className="num">{Number(p.base_salary).toFixed(3)} KD</td>
                    <td className="num" style={{ color: Number(p.attendance_deduction) > 0 ? '#e74c3c' : undefined }}>
                      {Number(p.attendance_deduction || 0).toFixed(3)} KD
                    </td>
                    <td className="num" style={{ fontWeight: 700 }}>{Number(p.total_paid).toFixed(3)} KD</td>
                    <td>{p.paid_date ? <Tag color="green">{t.payroll.paid}</Tag> : <Tag color="amber">{t.payroll.unpaid}</Tag>}</td>
                    <td>
                      {!p.paid_date && (
                        <button className="btn btn-secondary btn-sm" onClick={(e) => { e.stopPropagation(); markPaid(p.id); }}>
                          {t.payroll.markPaid}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedId === p.id && (
                    <tr>
                      <td colSpan={8} style={{ backgroundColor: '#fafaf9', padding: '12px 16px' }}>
                        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
                          <div>الأساسي: <strong>{Number(p.base_salary).toFixed(3)} KD</strong></div>
                          <div>مكافأة حضور: <strong>{Number(p.attendance_bonus || 0).toFixed(3)} KD</strong></div>
                          <div>خصومات أخرى: <strong>{Number(p.other_deductions || 0).toFixed(3)} KD</strong></div>
                          <div>خصم تأخير تلقائي: <strong>{Number(p.attendance_deduction || 0).toFixed(3)} KD</strong></div>
                          {p.wage_type === 'hourly' && (
                            <>
                              <div>ساعات العمل: <strong>{p.hours_worked !== null ? Number(p.hours_worked).toFixed(2) : '—'}</strong></div>
                              <div>سعر الساعة: <strong>{p.hourly_rate !== null ? Number(p.hourly_rate).toFixed(3) : '—'} KD</strong></div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">{t.payroll.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.payroll.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="payroll-form" disabled={loading}>
                {loading ? t.common.loading : t.payroll.generate}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="payroll-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.payroll.employee}</label>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
                <option value="">{t.payroll.selectEmployee}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name} ({emp.wage_type === 'hourly' ? 'بالساعة' : 'شهري'})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.payroll.month}</label>
              <input type="month" value={monthYear} onChange={(e) => setMonthYear(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t.payroll.bonus}</label>
              <input type="number" step="0.001" value={bonus} onChange={(e) => setBonus(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.payroll.deductions}</label>
              <input type="number" step="0.001" value={deductions} onChange={(e) => setDeductions(e.target.value)} />
            </div>
          </form>

          {selectedEmployee?.wage_type === 'hourly' && (
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              الأساسي بيُحسب تلقائياً من ساعات العمل المسجّلة بالحضور × سعر الساعة.
            </p>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            خصم التأخير (من الحضور) بينضاف تلقائياً — ما يحتاج إدخال يدوي.
          </p>

          <div className="hr" />
          <div className="section-title-row">
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>بنود إضافية (اختياري)</span>
            <button className="btn btn-secondary btn-sm" type="button" onClick={addAdjustment}>
              <IconPlus /> إضافة بند
            </button>
          </div>
          {adjustments.map((a, i) => (
            <div key={i} className="form-row" style={{ marginBottom: 8 }}>
              <div className="field" style={{ width: 110 }}>
                <select value={a.type} onChange={(e) => updateAdjustment(i, { type: e.target.value as 'bonus' | 'deduction' })}>
                  <option value="bonus">مكافأة +</option>
                  <option value="deduction">خصم −</option>
                </select>
              </div>
              <div className="field" style={{ flex: 2 }}>
                <input
                  placeholder="مثال: عيدية، غرامة معدات..."
                  value={a.label}
                  onChange={(e) => updateAdjustment(i, { label: e.target.value })}
                />
              </div>
              <div className="field" style={{ width: 100 }}>
                <input
                  type="number"
                  step="0.001"
                  placeholder="KD"
                  value={a.amount}
                  onChange={(e) => updateAdjustment(i, { amount: e.target.value })}
                />
              </div>
              <button className="icon-btn" type="button" onClick={() => removeAdjustment(i)} style={{ alignSelf: 'center' }}>
                ×
              </button>
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}
