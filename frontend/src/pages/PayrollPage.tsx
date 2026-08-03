import { FormEvent, Fragment, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import StatCard from '../components/StatCard';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';
import { exportRowsToCsv } from '../utils/csv';

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
  status?: 'pending' | 'paid';
  paid_date: string | null;
}
interface Employee {
  id: string;
  name: string;
  wage_type: 'monthly' | 'hourly';
  salary_monthly: number | null;
  hourly_rate: number | null;
}

// 26 working days × 8-hour shifts — the standard month used to derive an
// hourly/per-minute reference rate for monthly-salary employees (informational only,
// doesn't affect how their pay is actually calculated — that stays salary_monthly as-is).
const STANDARD_HOURS_PER_MONTH = 208;

interface Adjustment {
  type: 'bonus' | 'deduction';
  label: string;
  amount: string; // kept as string while editing in the form
}
interface AdjustmentDetail {
  type: 'bonus' | 'deduction';
  label: string;
  amount: number;
}

function monthStr() {
  return new Date().toISOString().slice(0, 7);
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function PayrollPage() {
  const t = useT();
  const company = useAuthStore((s) => s.company);
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';
  const [items, setItems] = useState<PayrollRecord[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState<'pending' | 'paid'>('pending');
  const [employeeId, setEmployeeId] = useState('');
  const [monthYear, setMonthYear] = useState(monthStr());
  const [paidDate, setPaidDate] = useState(todayStr());
  const [bonus, setBonus] = useState('');
  const [deductions, setDeductions] = useState('');
  const [finalAmount, setFinalAmount] = useState('');
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [filterEmployee, setFilterEmployee] = useState('');
  const [filterMonth, setFilterMonth] = useState('');

  function load(month?: string) {
    const query = month ? `?month=${month}` : '';
    get<{ payroll: PayrollRecord[] }>(`/payroll${query}`)
      .then((r) => setItems(r.payroll))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.payroll.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load(filterMonth || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterMonth]);

  const employeeName = (id: string) => employees.find((e) => e.id === id)?.name || id;
  const selectedEmployee = employees.find((e) => e.id === employeeId);
  const visibleItems = filterEmployee ? items.filter((p) => p.employee_id === filterEmployee) : items;

  const hourlyWage =
    selectedEmployee?.wage_type === 'hourly'
      ? selectedEmployee.hourly_rate ?? 0
      : selectedEmployee
        ? (selectedEmployee.salary_monthly ?? 0) / STANDARD_HOURS_PER_MONTH
        : null;
  const perMinuteWage = hourlyWage !== null ? hourlyWage / 60 : null;

  async function printPayslip(p: PayrollRecord) {
    setError(null);
    try {
      const detail = await get<{ payroll: PayrollRecord; adjustments: AdjustmentDetail[] }>(`/payroll/${p.id}`);
      const win = window.open('', '_blank');
      if (!win) return;
      const name = employeeName(p.employee_id);
      const rows: [string, string][] = [
        [t.payroll.baseDetail, `${Number(detail.payroll.base_salary).toFixed(3)} KD`],
      ];
      if (Number(detail.payroll.attendance_bonus) > 0) rows.push([t.payroll.attendanceBonusDetail, `${Number(detail.payroll.attendance_bonus).toFixed(3)} KD`]);
      if (Number(detail.payroll.other_deductions) > 0) rows.push([t.payroll.otherDeductionsDetail, `-${Number(detail.payroll.other_deductions).toFixed(3)} KD`]);
      if (Number(detail.payroll.attendance_deduction) > 0) rows.push([t.payroll.autoDeductionDetail, `-${Number(detail.payroll.attendance_deduction).toFixed(3)} KD`]);
      for (const adj of detail.adjustments) {
        rows.push([adj.label, `${adj.type === 'deduction' ? '-' : ''}${Number(adj.amount).toFixed(3)} KD`]);
      }
      win.document.write(`
        <!DOCTYPE html>
        <html dir="rtl" lang="ar">
        <head>
          <meta charset="utf-8" />
          <title>${t.payroll.payslipTitle(name, p.month_year)}</title>
          <style>
            body { font-family: 'Tajawal', Arial, sans-serif; padding: 40px; color: #1c1917; }
            .header { display: flex; justify-content: space-between; border-bottom: 2px solid #F5A623; padding-bottom: 12px; margin-bottom: 24px; }
            h1 { font-size: 20px; margin: 0 0 4px; }
            .meta { color: #57534e; font-size: 13px; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            td { padding: 8px 4px; border-bottom: 1px solid #e7e5e4; font-size: 14px; }
            td:last-child { text-align: left; direction: ltr; }
            .total-row td { font-weight: 800; font-size: 16px; border-top: 2px solid #1c1917; border-bottom: none; }
            @media print { body { padding: 0; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <h1>${company?.name || ''}</h1>
              <div class="meta">${t.payroll.payslipTitle(name, p.month_year)}</div>
            </div>
          </div>
          <table>
            ${rows.map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`).join('')}
            <tr class="total-row"><td>${t.payroll.netPay}</td><td>${Number(detail.payroll.total_paid).toFixed(3)} KD</td></tr>
          </table>
        </body>
        </html>
      `);
      win.document.close();
      win.focus();
      win.print();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.payroll.payslipLoadFailed);
    }
  }

  function addAdjustment() {
    setAdjustments((a) => [...a, { type: 'bonus', label: '', amount: '' }]);
  }
  function updateAdjustment(i: number, patch: Partial<Adjustment>) {
    setAdjustments((a) => a.map((adj, idx) => (idx === i ? { ...adj, ...patch } : adj)));
  }
  function removeAdjustment(i: number) {
    setAdjustments((a) => a.filter((_, idx) => idx !== i));
  }

  function openCreate() {
    setEditingId(null);
    setEmployeeId('');
    setMonthYear(monthStr());
    setPaidDate(todayStr());
    setBonus('');
    setDeductions('');
    setFinalAmount('');
    setAdjustments([]);
    setEditStatus('pending');
    setOpen(true);
  }

  async function openEdit(p: PayrollRecord) {
    setError(null);
    setEditingId(p.id);
    setEmployeeId(p.employee_id);
    setMonthYear(p.month_year);
    setPaidDate(p.paid_date ? p.paid_date.slice(0, 10) : '');
    setBonus(String(p.attendance_bonus || 0));
    setDeductions(String(p.other_deductions || 0));
    setFinalAmount(String(p.total_paid));
    setEditStatus(p.paid_date ? 'paid' : 'pending');
    setAdjustments([]);
    setOpen(true);
    try {
      const detail = await get<{ adjustments: AdjustmentDetail[] }>(`/payroll/${p.id}`);
      setAdjustments(detail.adjustments.map((a) => ({ type: a.type, label: a.label, amount: String(a.amount) })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.payroll.loadFailed);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const validAdjustments = adjustments
        .filter((a) => a.label.trim() && a.amount)
        .map((a) => ({ type: a.type, label: a.label.trim(), amount: Number(a.amount) }));

      if (editingId) {
        await patch(`/payroll/${editingId}`, {
          attendance_bonus: bonus ? Number(bonus) : 0,
          other_deductions: deductions ? Number(deductions) : 0,
          adjustments: validAdjustments,
          paid_date: editStatus === 'paid' ? paidDate || todayStr() : null,
          status: editStatus,
          total_paid_override: finalAmount ? Number(finalAmount) : undefined,
        });
      } else {
        await post('/payroll', {
          employee_id: employeeId,
          month_year: monthYear,
          paid_date: paidDate || undefined,
          attendance_bonus: bonus ? Number(bonus) : undefined,
          other_deductions: deductions ? Number(deductions) : undefined,
          adjustments: validAdjustments,
          total_paid_override: finalAmount ? Number(finalAmount) : undefined,
        });
      }
      setBonus('');
      setDeductions('');
      setFinalAmount('');
      setPaidDate(todayStr());
      setAdjustments([]);
      setEditingId(null);
      setOpen(false);
      load(filterMonth || undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.payroll.updateFailed : t.payroll.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function markPaid(id: string) {
    setError(null);
    try {
      await post(`/payroll/${id}/pay`);
      load(filterMonth || undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.payroll.payFailed);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.payroll.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/payroll/${id}`);
      load(filterMonth || undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.payroll.deleteFailed);
    }
  }

  function exportCsv() {
    exportRowsToCsv(
      `payroll_${filterMonth || 'all'}.csv`,
      [t.payroll.employee, t.payroll.month, t.payroll.wageType, t.payroll.base, t.payroll.attendanceDeductionCol, t.payroll.netCol, t.payroll.status],
      visibleItems.map((p) => [
        employeeName(p.employee_id),
        p.month_year,
        p.wage_type === 'hourly' ? t.payroll.hourly : t.payroll.monthly,
        Number(p.base_salary).toFixed(3),
        Number(p.attendance_deduction || 0).toFixed(3),
        Number(p.total_paid).toFixed(3),
        p.paid_date ? t.payroll.paid : t.payroll.unpaid,
      ])
    );
  }

  return (
    <div>
      <PageHeader title={t.payroll.title} subtitle={t.payroll.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.payroll.count(visibleItems.length)}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={exportCsv}>
            {t.payroll.exportCsv}
          </button>
          <button className="btn btn-primary btn-sm" onClick={openCreate}>
            <IconPlus /> {t.payroll.newItem}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="form-row">
          <div className="field" style={{ maxWidth: 220 }}>
            <label>{t.payroll.filterEmployee}</label>
            <select value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)}>
              <option value="">{t.payroll.allEmployees}</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ maxWidth: 200 }}>
            <label>{t.payroll.filterMonth}</label>
            <input type="month" value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)} placeholder={t.payroll.allMonths} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.payroll.employee}</th>
                <th>{t.payroll.month}</th>
                <th>{t.payroll.wageType}</th>
                <th className="num">{t.payroll.base}</th>
                <th className="num">{t.payroll.attendanceDeductionCol}</th>
                <th className="num">{t.payroll.netCol}</th>
                <th>{t.payroll.status}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((p) => (
                <Fragment key={p.id}>
                  <tr style={{ cursor: 'pointer' }} onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}>
                    <td style={{ fontWeight: 700 }}>{employeeName(p.employee_id)}</td>
                    <td>{p.month_year}</td>
                    <td>
                      {p.wage_type === 'hourly'
                        ? `${t.payroll.hourly}${p.hours_worked !== null ? t.payroll.hourlySuffix(Number(p.hours_worked).toFixed(1)) : ''}`
                        : t.payroll.monthly}
                    </td>
                    <td className="num">{Number(p.base_salary).toFixed(3)} KD</td>
                    <td className="num" style={{ color: Number(p.attendance_deduction) > 0 ? '#e74c3c' : undefined }}>
                      {Number(p.attendance_deduction || 0).toFixed(3)} KD
                    </td>
                    <td className="num" style={{ fontWeight: 700 }}>{Number(p.total_paid).toFixed(3)} KD</td>
                    <td>{p.paid_date ? <Tag color="green">{t.payroll.paid}</Tag> : <Tag color="amber">{t.payroll.unpaid}</Tag>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-secondary btn-sm" onClick={(e) => { e.stopPropagation(); printPayslip(p); }}>
                        {t.payroll.payslip}
                      </button>{' '}
                      {!p.paid_date && (
                        <button className="btn btn-secondary btn-sm" onClick={(e) => { e.stopPropagation(); markPaid(p.id); }}>
                          {t.payroll.markPaid}
                        </button>
                      )}{' '}
                      {isManager && (
                        <>
                          <button className="icon-btn" title={t.payroll.editItem} onClick={(e) => { e.stopPropagation(); openEdit(p); }}>
                            <IconEdit />
                          </button>
                          <button className="icon-btn" title={t.common.delete} onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}>
                            <IconTrash />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {expandedId === p.id && (
                    <tr>
                      <td colSpan={8} style={{ backgroundColor: '#fafaf9', padding: '12px 16px' }}>
                        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
                          <div>{t.payroll.baseDetail}: <strong>{Number(p.base_salary).toFixed(3)} KD</strong></div>
                          <div>{t.payroll.attendanceBonusDetail}: <strong>{Number(p.attendance_bonus || 0).toFixed(3)} KD</strong></div>
                          <div>{t.payroll.otherDeductionsDetail}: <strong>{Number(p.other_deductions || 0).toFixed(3)} KD</strong></div>
                          <div>{t.payroll.autoDeductionDetail}: <strong>{Number(p.attendance_deduction || 0).toFixed(3)} KD</strong></div>
                          {p.wage_type === 'hourly' && (
                            <>
                              <div>{t.payroll.hoursWorkedDetail}: <strong>{p.hours_worked !== null ? Number(p.hours_worked).toFixed(2) : '—'}</strong></div>
                              <div>{t.payroll.hourlyRateDetail}: <strong>{p.hourly_rate !== null ? Number(p.hourly_rate).toFixed(3) : '—'} KD</strong></div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {visibleItems.length === 0 && (
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
          title={editingId ? t.payroll.editItem : t.payroll.newItem}
          onClose={() => {
            setOpen(false);
            setEditingId(null);
          }}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="payroll-form" disabled={loading}>
                {loading ? t.common.loading : editingId ? t.common.save : t.payroll.generate}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  setOpen(false);
                  setEditingId(null);
                }}
              >
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="payroll-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.payroll.month}</label>
              <input type="month" value={monthYear} onChange={(e) => setMonthYear(e.target.value)} required disabled={!!editingId} />
            </div>
            <div className="field">
              <label>{t.payroll.employee}</label>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required disabled={!!editingId}>
                <option value="">{t.payroll.selectEmployee}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name} ({emp.wage_type === 'hourly' ? t.payroll.hourly : t.payroll.monthly})
                  </option>
                ))}
              </select>
            </div>
            {editingId ? (
              <div className="field">
                <label>{t.payroll.status}</label>
                <select value={editStatus} onChange={(e) => setEditStatus(e.target.value as 'pending' | 'paid')}>
                  <option value="pending">{t.payroll.unpaid}</option>
                  <option value="paid">{t.payroll.paid}</option>
                </select>
              </div>
            ) : null}
            <div className="field">
              <label>{t.payroll.paidDate}</label>
              <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} disabled={!!editingId && editStatus !== 'paid'} />
            </div>
          </form>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {editingId ? t.payroll.editLockedNote : t.payroll.paidDateHint}
          </p>

          {selectedEmployee && (
            <>
              <div className="stat-grid" style={{ marginTop: 12, marginBottom: 4 }}>
                <StatCard label={t.payroll.perMinuteWage} value={`${(perMinuteWage ?? 0).toFixed(3)} KD`} />
                <StatCard label={t.payroll.perHourWage} value={`${(hourlyWage ?? 0).toFixed(3)} KD`} />
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
                {t.payroll.wageBasisNote}
              </p>
            </>
          )}

          {selectedEmployee?.wage_type === 'hourly' && (
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {t.payroll.hourlyAutoNote}
            </p>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {t.payroll.autoDeductionNote}
          </p>

          <div className="hr" />
          <div className="section-title-row">
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.payroll.extraItemsTitle}</span>
            <button className="btn btn-secondary btn-sm" type="button" onClick={addAdjustment}>
              <IconPlus /> {t.payroll.addItem}
            </button>
          </div>
          {adjustments.map((a, i) => (
            <div key={i} className="form-row" style={{ marginBottom: 8 }}>
              <div className="field" style={{ width: 110 }}>
                <select value={a.type} onChange={(e) => updateAdjustment(i, { type: e.target.value as 'bonus' | 'deduction' })}>
                  <option value="bonus">{t.payroll.itemBonus}</option>
                  <option value="deduction">{t.payroll.itemDeduction}</option>
                </select>
              </div>
              <div className="field" style={{ flex: 2 }}>
                <input
                  placeholder={t.payroll.itemLabelPlaceholder}
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
                <IconTrash />
              </button>
            </div>
          ))}

          <div className="hr" />
          <div className="field">
            <label>{t.payroll.finalAmount}</label>
            <input
              type="number"
              step="0.001"
              placeholder={t.common.auto}
              value={finalAmount}
              onChange={(e) => setFinalAmount(e.target.value)}
            />
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {t.payroll.finalAmountNote}
          </p>
        </Modal>
      )}
    </div>
  );
}
