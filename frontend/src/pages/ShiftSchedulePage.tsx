import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

interface Employee {
  id: string;
  name: string;
}
interface Location {
  id: string;
  name: string;
}
interface ScheduleEntry {
  id: string;
  employee_id: string;
  employee_name: string;
  location_id: string | null;
  location_name: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(dateStr: string, days: number) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function ShiftSchedulePage() {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';

  const [items, setItems] = useState<ScheduleEntry[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(addDays(todayStr(), 6));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [date, setDate] = useState(todayStr());
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [notes, setNotes] = useState('');

  function load() {
    get<{ shift_schedules: ScheduleEntry[] }>(`/shift-schedules?from=${from}&to=${to}`)
      .then((r) => setItems(r.shift_schedules))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.shiftSchedule.loadFailed));
  }

  useEffect(() => {
    get<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees)).catch(() => {});
    get<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  function resetForm() {
    setEmployeeId('');
    setLocationId('');
    setDate(from);
    setStartTime('');
    setEndTime('');
    setNotes('');
  }

  function openCreate() {
    resetForm();
    setEditingId(null);
    setOpen(true);
  }

  function openEdit(entry: ScheduleEntry) {
    setEditingId(entry.id);
    setEmployeeId(entry.employee_id);
    setLocationId(entry.location_id || '');
    setDate(entry.date.slice(0, 10));
    setStartTime(entry.start_time ? entry.start_time.slice(0, 5) : '');
    setEndTime(entry.end_time ? entry.end_time.slice(0, 5) : '');
    setNotes(entry.notes || '');
    setOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = {
        employee_id: employeeId,
        location_id: locationId || undefined,
        date,
        start_time: startTime || undefined,
        end_time: endTime || undefined,
        notes: notes || undefined,
      };
      if (editingId) {
        await patch(`/shift-schedules/${editingId}`, payload);
      } else {
        await post('/shift-schedules', payload);
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : editingId ? t.shiftSchedule.updateFailed : t.shiftSchedule.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.shiftSchedule.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/shift-schedules/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.shiftSchedule.deleteFailed);
    }
  }

  return (
    <div>
      <PageHeader title={t.shiftSchedule.title} subtitle={t.shiftSchedule.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="form-row">
          <div className="field" style={{ maxWidth: 180 }}>
            <label>{t.shiftSchedule.from}</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ maxWidth: 180 }}>
            <label>{t.shiftSchedule.to}</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="section-title-row">
        <span className="muted">{t.shiftSchedule.count(items.length)}</span>
        {isManager && (
          <button className="btn btn-primary btn-sm" onClick={openCreate}>
            <IconPlus /> {t.shiftSchedule.newItem}
          </button>
        )}
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.shiftSchedule.date}</th>
                <th>{t.shiftSchedule.employee}</th>
                <th>{t.shiftSchedule.location}</th>
                <th>{t.shiftSchedule.startTime}</th>
                <th>{t.shiftSchedule.endTime}</th>
                <th>{t.shiftSchedule.notes}</th>
                {isManager && <th></th>}
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.id}>
                  <td className="num">{entry.date.slice(0, 10)}</td>
                  <td style={{ fontWeight: 700 }}>{entry.employee_name}</td>
                  <td>{entry.location_name || '—'}</td>
                  <td className="num">{entry.start_time ? entry.start_time.slice(0, 5) : '—'}</td>
                  <td className="num">{entry.end_time ? entry.end_time.slice(0, 5) : '—'}</td>
                  <td>{entry.notes || '—'}</td>
                  {isManager && (
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" title={t.shiftSchedule.editItem} onClick={() => openEdit(entry)}>
                        <IconEdit />
                      </button>
                      <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(entry.id)}>
                        <IconTrash />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={isManager ? 7 : 6}>
                    <div className="empty-state">{t.shiftSchedule.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? t.shiftSchedule.editItem : t.shiftSchedule.newItem}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="submit" form="shift-schedule-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <form id="shift-schedule-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field">
              <label>{t.shiftSchedule.employee}</label>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
                <option value="">{t.shiftSchedule.selectEmployee}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.shiftSchedule.location}</label>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">{t.shiftSchedule.selectLocation}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.shiftSchedule.date}</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t.shiftSchedule.startTime}</label>
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.shiftSchedule.endTime}</label>
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.shiftSchedule.notes}</label>
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
