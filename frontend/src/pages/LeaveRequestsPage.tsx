import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import { IconPlus } from '../components/Icon';

interface Employee {
  id: string;
  name: string;
}

interface LeaveRequest {
  id: string;
  employee_id: string;
  employee_name: string;
  type: string;
  start_date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
  attachment_base64: string | null;
  status: string;
}

const TYPE_COLOR: Record<string, string> = {
  annual_leave: '#3b82f6',
  sick_leave: '#ef4444',
  permission: '#f59e0b',
};

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function LeaveRequestsPage() {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const [employeeId, setEmployeeId] = useState('');
  const [type, setType] = useState('annual_leave');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [reason, setReason] = useState('');
  const [attachment, setAttachment] = useState<string | null>(null);

  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth() + 1); // 1-12
  const [calLeaves, setCalLeaves] = useState<LeaveRequest[]>([]);

  function loadRequests() {
    get<{ leave_requests: LeaveRequest[] }>('/leave-requests')
      .then((r) => setRequests(r.leave_requests))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.leaveRequests.loadFailed));
  }

  function loadCalendar(year: number, month: number) {
    get<{ leave_requests: LeaveRequest[] }>(`/leave-requests/calendar?year=${year}&month=${month}`)
      .then((r) => setCalLeaves(r.leave_requests))
      .catch(() => {});
  }

  useEffect(() => {
    get<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees)).catch(() => {});
    loadRequests();
    loadCalendar(calYear, calMonth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeMonth(delta: number) {
    let y = calYear;
    let m = calMonth + delta;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    setCalYear(y);
    setCalMonth(m);
    loadCalendar(y, m);
  }

  async function handleAttachmentChange(file: File | undefined) {
    if (!file) return;
    setAttachment(await readFileAsBase64(file));
  }

  function resetForm() {
    setEmployeeId('');
    setType('annual_leave');
    setStartDate('');
    setEndDate('');
    setStartTime('');
    setEndTime('');
    setReason('');
    setAttachment(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await post('/leave-requests', {
        employee_id: employeeId,
        type,
        start_date: startDate,
        end_date: type === 'permission' ? undefined : endDate || undefined,
        start_time: type === 'permission' ? startTime || undefined : undefined,
        end_time: type === 'permission' ? endTime || undefined : undefined,
        reason: reason || undefined,
        attachment_base64: attachment || undefined,
      });
      resetForm();
      setOpen(false);
      loadRequests();
      loadCalendar(calYear, calMonth);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.leaveRequests.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function reviewRequest(id: string, status: 'approved' | 'rejected') {
    setError(null);
    try {
      await patch(`/leave-requests/${id}`, { status });
      loadRequests();
      loadCalendar(calYear, calMonth);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.leaveRequests.updateFailed);
    }
  }

  function typeLabel(ty: string) {
    if (ty === 'annual_leave') return t.leaveRequests.typeAnnual;
    if (ty === 'sick_leave') return t.leaveRequests.typeSick;
    return t.leaveRequests.typePermission;
  }

  function statusTag(status: string) {
    if (status === 'approved') return <Tag color="green">{t.leaveRequests.statusApproved}</Tag>;
    if (status === 'rejected') return <Tag color="red">{t.leaveRequests.statusRejected}</Tag>;
    return <Tag color="amber">{t.leaveRequests.statusPending}</Tag>;
  }

  // Build day -> leaves-covering-that-day map for the calendar grid.
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const firstWeekday = new Date(calYear, calMonth - 1, 1).getDay(); // 0=Sun
  const dayMap: Record<number, LeaveRequest[]> = {};
  for (const lr of calLeaves) {
    const start = new Date(lr.start_date);
    const end = lr.end_date ? new Date(lr.end_date) : start;
    for (let d = 1; d <= daysInMonth; d++) {
      const day = new Date(calYear, calMonth - 1, d);
      if (day >= new Date(start.getFullYear(), start.getMonth(), start.getDate()) && day <= new Date(end.getFullYear(), end.getMonth(), end.getDate())) {
        (dayMap[d] ||= []).push(lr);
      }
    }
  }
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  return (
    <div>
      <PageHeader title={t.leaveRequests.title} subtitle={t.leaveRequests.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.leaveRequests.count(requests.length)}</span>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            resetForm();
            setOpen(true);
          }}
        >
          <IconPlus /> {t.leaveRequests.newItem}
        </button>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t.leaveRequests.calendarTitle}</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => changeMonth(-1)}>
              {t.leaveRequests.prevMonth}
            </button>
            <span style={{ alignSelf: 'center', fontWeight: 700, fontSize: 13 }}>
              {calYear}-{String(calMonth).padStart(2, '0')}
            </span>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => changeMonth(1)}>
              {t.leaveRequests.nextMonth}
            </button>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {cells.map((day, i) => (
              <div
                key={i}
                style={{
                  minHeight: 56,
                  border: '1px solid var(--stone-100)',
                  borderRadius: 6,
                  padding: 4,
                  fontSize: 11,
                  background: day ? '#fff' : 'transparent',
                }}
              >
                {day && (
                  <>
                    <div className="muted" style={{ fontSize: 10 }}>
                      {day}
                    </div>
                    {(dayMap[day] || []).slice(0, 3).map((lr) => (
                      <div
                        key={lr.id}
                        title={`${lr.employee_name} — ${typeLabel(lr.type)}`}
                        style={{
                          background: TYPE_COLOR[lr.type] || '#999',
                          color: '#fff',
                          borderRadius: 3,
                          padding: '1px 4px',
                          marginTop: 2,
                          fontSize: 9,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {lr.employee_name}
                      </div>
                    ))}
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t.leaveRequests.listTitle}</h2>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.leaveRequests.employee}</th>
                <th>{t.leaveRequests.type}</th>
                <th>{t.leaveRequests.startDate}</th>
                <th>{t.leaveRequests.endDate}</th>
                <th>{t.leaveRequests.status}</th>
                {isManager && <th></th>}
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 700 }}>{r.employee_name}</td>
                  <td>{typeLabel(r.type)}</td>
                  <td>{r.start_date.slice(0, 10)}</td>
                  <td>{r.end_date ? r.end_date.slice(0, 10) : '—'}</td>
                  <td>{statusTag(r.status)}</td>
                  {isManager && (
                    <td>
                      {r.status === 'pending' && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-primary btn-sm" onClick={() => reviewRequest(r.id, 'approved')}>
                            {t.leaveRequests.approve}
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => reviewRequest(r.id, 'rejected')}>
                            {t.leaveRequests.reject}
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {requests.length === 0 && (
                <tr>
                  <td colSpan={isManager ? 6 : 5}>
                    <div className="empty-state">{t.leaveRequests.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.leaveRequests.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="leave-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="leave-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.leaveRequests.employee}</label>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
                <option value="">{t.leaveRequests.selectEmployee}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.leaveRequests.type}</label>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="annual_leave">{t.leaveRequests.typeAnnual}</option>
                <option value="sick_leave">{t.leaveRequests.typeSick}</option>
                <option value="permission">{t.leaveRequests.typePermission}</option>
              </select>
            </div>
            <div className="field">
              <label>{t.leaveRequests.startDate}</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
            </div>
            {type !== 'permission' ? (
              <div className="field">
                <label>{t.leaveRequests.endDate}</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            ) : (
              <>
                <div className="field">
                  <label>{t.leaveRequests.startTime}</label>
                  <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                </div>
                <div className="field">
                  <label>{t.leaveRequests.endTime}</label>
                  <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                </div>
              </>
            )}
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.leaveRequests.reason}</label>
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.leaveRequests.attachment}</label>
              <input type="file" onChange={(e) => handleAttachmentChange(e.target.files?.[0])} />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
