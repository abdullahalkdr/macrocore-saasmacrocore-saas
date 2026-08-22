import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

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
  manager_note: string | null;
}

// Green = annual leave, red = sick leave, orange = permission — matches the status
// legend shown above the calendar.
const TYPE_COLOR: Record<string, string> = {
  annual_leave: '#059669',
  sick_leave: '#ef4444',
  permission: '#f59e0b',
};

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [employeeId, setEmployeeId] = useState('');
  const [type, setType] = useState('annual_leave');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [reason, setReason] = useState('');
  const [attachment, setAttachment] = useState<string | null>(null);
  const [status, setStatus] = useState('pending');
  const [managerNote, setManagerNote] = useState('');

  // Full-year calendar — all 12 months of calYear, not just the current month.
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [calByMonth, setCalByMonth] = useState<Record<number, LeaveRequest[]>>({});

  function loadRequests() {
    get<{ leave_requests: LeaveRequest[] }>('/leave-requests')
      .then((r) => setRequests(r.leave_requests))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.leaveRequests.loadFailed));
  }

  function loadCalendarYear(year: number) {
    Promise.all(
      MONTHS.map((m) =>
        get<{ leave_requests: LeaveRequest[] }>(`/leave-requests/calendar?year=${year}&month=${m}`)
          .then((r): [number, LeaveRequest[]] => [m, r.leave_requests])
          .catch((): [number, LeaveRequest[]] => [m, []])
      )
    ).then((pairs) => {
      const byMonth: Record<number, LeaveRequest[]> = {};
      for (const [m, leaves] of pairs) byMonth[m] = leaves;
      setCalByMonth(byMonth);
    });
  }

  useEffect(() => {
    // Only admin/manager ever see/use the employee picker below (the create form hides
    // it for a plain employee, who self-files against their own linked record instead —
    // see MIGRATION_040 / leaveRequests.controller.ts create()). Skip exposing the full
    // company roster to someone who has no use for it.
    if (isManager) {
      get<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees)).catch(() => {});
    }
    loadRequests();
    loadCalendarYear(calYear);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeYear(delta: number) {
    const y = calYear + delta;
    setCalYear(y);
    loadCalendarYear(y);
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
    setStatus('pending');
    setManagerNote('');
  }

  function openCreate() {
    resetForm();
    setEditingId(null);
    setOpen(true);
  }

  function openEdit(r: LeaveRequest) {
    setEditingId(r.id);
    setEmployeeId(r.employee_id);
    setType(r.type);
    setStartDate(r.start_date.slice(0, 10));
    setEndDate(r.end_date ? r.end_date.slice(0, 10) : '');
    setStartTime(r.start_time ? r.start_time.slice(0, 5) : '');
    setEndTime(r.end_time ? r.end_time.slice(0, 5) : '');
    setReason(r.reason || '');
    setAttachment(null);
    setStatus(r.status);
    setManagerNote(r.manager_note || '');
    setOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const base = {
        // Omitted entirely for a plain employee — the backend resolves it from their
        // own account and ignores anything sent here anyway (audit finding #2 fix).
        employee_id: isManager ? employeeId : undefined,
        type,
        start_date: startDate,
        end_date: type === 'permission' ? undefined : endDate || undefined,
        start_time: type === 'permission' ? startTime || undefined : undefined,
        end_time: type === 'permission' ? endTime || undefined : undefined,
        reason: reason || undefined,
        attachment_base64: attachment || undefined,
      };
      if (editingId) {
        await patch(`/leave-requests/${editingId}`, { ...base, status, manager_note: managerNote || undefined });
      } else {
        await post('/leave-requests', base);
      }
      resetForm();
      setEditingId(null);
      setOpen(false);
      loadRequests();
      loadCalendarYear(calYear);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.leaveRequests.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.leaveRequests.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/leave-requests/${id}`);
      loadRequests();
      loadCalendarYear(calYear);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.leaveRequests.deleteFailed);
    }
  }

  async function handleQuickStatus(id: string, newStatus: 'approved' | 'rejected') {
    setError(null);
    try {
      await patch(`/leave-requests/${id}`, { status: newStatus });
      loadRequests();
      loadCalendarYear(calYear);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.leaveRequests.saveFailed);
    }
  }

  function typeLabel(ty: string) {
    if (ty === 'annual_leave') return t.leaveRequests.typeAnnual;
    if (ty === 'sick_leave') return t.leaveRequests.typeSick;
    return t.leaveRequests.typePermission;
  }

  function statusTag(s: string) {
    if (s === 'approved') return <Tag color="green">{t.leaveRequests.statusApproved}</Tag>;
    if (s === 'rejected') return <Tag color="red">{t.leaveRequests.statusRejected}</Tag>;
    return <Tag color="amber">{t.leaveRequests.statusPending}</Tag>;
  }

  function viewAttachment(base64: string) {
    const w = window.open();
    if (w) w.document.write(`<img src="${base64}" style="max-width:100%" />`);
  }

  function monthGrid(month: number) {
    const daysInMonth = new Date(calYear, month, 0).getDate();
    const firstWeekday = new Date(calYear, month - 1, 1).getDay();
    const leaves = calByMonth[month] || [];
    const dayMap: Record<number, LeaveRequest[]> = {};
    for (const lr of leaves) {
      const start = new Date(lr.start_date);
      const end = lr.end_date ? new Date(lr.end_date) : start;
      for (let d = 1; d <= daysInMonth; d++) {
        const day = new Date(calYear, month - 1, d);
        if (
          day >= new Date(start.getFullYear(), start.getMonth(), start.getDate()) &&
          day <= new Date(end.getFullYear(), end.getMonth(), end.getDate())
        ) {
          (dayMap[d] ||= []).push(lr);
        }
      }
    }
    const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
    return { cells, dayMap };
  }

  const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'long' });

  return (
    <div>
      <PageHeader title={t.leaveRequests.title} subtitle={t.leaveRequests.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.leaveRequests.count(requests.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.leaveRequests.newItem}
        </button>
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
                <th>{t.leaveRequests.reason}</th>
                <th>{t.leaveRequests.attachment}</th>
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
                  <td>{r.reason || '—'}</td>
                  <td>
                    {r.attachment_base64 ? (
                      <a href="#" onClick={(e) => { e.preventDefault(); viewAttachment(r.attachment_base64 as string); }}>
                        {t.leaveRequests.viewAttachment}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{statusTag(r.status)}</td>
                  {isManager && (
                    <td>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        {r.status === 'pending' && (
                          <>
                            <button className="btn btn-primary btn-sm" onClick={() => handleQuickStatus(r.id, 'approved')}>
                              {t.leaveRequests.approve}
                            </button>
                            <button className="btn btn-secondary btn-sm" onClick={() => handleQuickStatus(r.id, 'rejected')}>
                              {t.leaveRequests.reject}
                            </button>
                          </>
                        )}
                        <button className="icon-btn" title={t.leaveRequests.editItem} onClick={() => openEdit(r)}>
                          <IconEdit />
                        </button>
                        <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(r.id)}>
                          <IconTrash />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {requests.length === 0 && (
                <tr>
                  <td colSpan={isManager ? 8 : 7}>
                    <div className="empty-state">{t.leaveRequests.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t.leaveRequests.calendarTitle}</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => changeYear(-1)}>
              {t.leaveRequests.prevMonth}
            </button>
            <span style={{ alignSelf: 'center', fontWeight: 700, fontSize: 13 }}>{calYear}</span>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => changeYear(1)}>
              {t.leaveRequests.nextMonth}
            </button>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 12 }}>
            {(['annual_leave', 'sick_leave', 'permission'] as const).map((ty) => (
              <div key={ty} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: TYPE_COLOR[ty], display: 'inline-block' }} />
                {typeLabel(ty)}
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {MONTHS.map((month) => {
              const { cells, dayMap } = monthGrid(month);
              return (
                <div key={month} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 8 }}>
                  <div style={{ fontWeight: 800, fontSize: 12, marginBottom: 6, textAlign: 'center' }}>
                    {monthFormatter.format(new Date(calYear, month - 1, 1))} {calYear}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
                    {cells.map((day, i) => (
                      <div
                        key={i}
                        title={(dayMap[day || 0] || []).map((lr) => `${lr.employee_name} — ${typeLabel(lr.type)}`).join('\n')}
                        style={{
                          minHeight: 20,
                          borderRadius: 3,
                          fontSize: 9,
                          textAlign: 'center',
                          padding: 1,
                          background: day && (dayMap[day] || []).length > 0 ? TYPE_COLOR[dayMap[day][0].type] || '#999' : 'transparent',
                          color: day && (dayMap[day] || []).length > 0 ? '#fff' : 'var(--muted)',
                        }}
                      >
                        {day || ''}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? t.leaveRequests.editItem : t.leaveRequests.newItem}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="leave-form" disabled={loading}>
                {loading ? t.common.loading : editingId ? t.leaveRequests.saveEdit : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="leave-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.leaveRequests.type}</label>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="annual_leave">{t.leaveRequests.typeAnnual}</option>
                <option value="sick_leave">{t.leaveRequests.typeSick}</option>
                <option value="permission">{t.leaveRequests.typePermission}</option>
              </select>
            </div>
            {isManager && (
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
            )}
            {editingId && (
              <div className="field">
                <label>{t.leaveRequests.status}</label>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="pending">{t.leaveRequests.statusPending}</option>
                  <option value="approved">{t.leaveRequests.statusApproved}</option>
                  <option value="rejected">{t.leaveRequests.statusRejected}</option>
                </select>
              </div>
            )}
            {type !== 'permission' ? (
              <>
                <div className="field">
                  <label>{t.leaveRequests.startDate}</label>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
                </div>
                <div className="field">
                  <label>{t.leaveRequests.endDate}</label>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <label>{t.leaveRequests.startTime}</label>
                  <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                </div>
                <div className="field">
                  <label>{t.leaveRequests.startDate}</label>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
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
            {editingId && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>{t.leaveRequests.managerNote}</label>
                <textarea rows={2} value={managerNote} onChange={(e) => setManagerNote(e.target.value)} />
              </div>
            )}
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.leaveRequests.attachment}</label>
              <input type="file" onChange={(e) => handleAttachmentChange(e.target.files?.[0])} />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
