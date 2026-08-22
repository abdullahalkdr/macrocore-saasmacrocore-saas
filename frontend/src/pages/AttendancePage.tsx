import { useEffect, useState } from 'react';
import { get, post, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import Tag from '../components/Tag';

interface Employee {
  id: string;
  name: string;
}

interface AttendanceRecord {
  id: string;
  employee_id: string;
  employee_name: string;
  date: string;
  clock_in: string | null;
  clock_out: string | null;
  late_minutes: number;
  deduction_amount: number;
  status: string;
}

export default function AttendancePage() {
  const t = useT();
  // Backend already forces employee_id server-side for role='employee' (attendance
  // ownership fix) — the roster picker below is only meaningful for admin/manager
  // clocking in someone else. Showing it to a plain employee let them "pick" a
  // colleague, click Clock in, and watch it silently record THEIR OWN attendance
  // instead — looked like a bug even though the backend was already safe. Hide it
  // for employees and self-clock directly.
  const currentUser = useAuthStore((s) => s.user);
  const isEmployee = currentUser?.role === 'employee';
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    get<{ attendance: AttendanceRecord[] }>('/attendance')
      .then((r) => setRecords(r.attendance))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.attendance.loadFailed));
  }

  useEffect(() => {
    // Also skips exposing the full employee roster (names) to a plain employee, who
    // has no use for it now that the picker is hidden for them.
    if (!isEmployee) {
      get<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees)).catch(() => {});
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleClockIn() {
    if (!isEmployee && !selectedEmployee) return;
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      // employee_id is omitted for a plain employee — the backend resolves it from
      // their own account and ignores anything sent here anyway.
      await post('/attendance/clock-in', isEmployee ? {} : { employee_id: selectedEmployee });
      setSuccess(t.attendance.clockIn);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.attendance.clockInFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleClockOut() {
    if (!isEmployee && !selectedEmployee) return;
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      await post('/attendance/clock-out', isEmployee ? {} : { employee_id: selectedEmployee });
      setSuccess(t.attendance.clockOut);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.attendance.clockOutFailed);
    } finally {
      setLoading(false);
    }
  }

  function statusTag(status: string) {
    if (status === 'present') return <Tag color="green">{t.attendance.statusPresent}</Tag>;
    if (status === 'late') return <Tag color="amber">{t.attendance.statusLate}</Tag>;
    return <Tag color="red">{t.attendance.statusAbsent}</Tag>;
  }

  function timeOnly(iso: string | null) {
    if (!iso) return '—';
    return new Date(iso).toISOString().slice(11, 16);
  }

  return (
    <div>
      <PageHeader title={t.attendance.title} subtitle={t.attendance.subtitle} />
      {error && <div className="error-banner">{error}</div>}
      {success && <div className="success-banner">{success}</div>}

      <div className="card">
        <div className="form-row">
          {!isEmployee && (
            <div className="field" style={{ flex: 2 }}>
              <label>{t.attendance.employee}</label>
              <select value={selectedEmployee} onChange={(e) => setSelectedEmployee(e.target.value)}>
                <option value="">{t.attendance.selectEmployee}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button className="btn btn-primary" type="button" disabled={(!isEmployee && !selectedEmployee) || loading} onClick={handleClockIn}>
            {t.attendance.clockIn}
          </button>
          <button className="btn btn-secondary" type="button" disabled={(!isEmployee && !selectedEmployee) || loading} onClick={handleClockOut}>
            {t.attendance.clockOut}
          </button>
        </div>
      </div>

      <div className="section-title-row">
        <span className="muted">{t.attendance.count(records.length)}</span>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.attendance.employee}</th>
                <th>{t.attendance.date}</th>
                <th className="num">{t.attendance.clockInCol}</th>
                <th className="num">{t.attendance.clockOutCol}</th>
                <th className="num">{t.attendance.lateMinutes}</th>
                <th className="num">{t.attendance.deduction}</th>
                <th>{t.attendance.status}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 700 }}>{r.employee_name}</td>
                  <td>{r.date.slice(0, 10)}</td>
                  <td className="num">{timeOnly(r.clock_in)}</td>
                  <td className="num">{timeOnly(r.clock_out)}</td>
                  <td className="num">{r.late_minutes}</td>
                  <td className="num">{Number(r.deduction_amount).toFixed(3)}</td>
                  <td>{statusTag(r.status)}</td>
                </tr>
              ))}
              {records.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">{t.attendance.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
