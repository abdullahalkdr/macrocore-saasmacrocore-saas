import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import { IconPlus } from '../components/Icon';

interface Ticket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  created_at: string;
}
interface Reply {
  id: string;
  message: string;
  is_admin_reply: boolean;
  created_at: string;
}
interface TicketDetail extends Ticket {
  description: string;
  replies: Reply[];
}

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const statusTagColor = (s: string): 'green' | 'red' | 'amber' | 'gray' =>
  s === 'open' ? 'green' : s === 'closed' ? 'gray' : s === 'resolved' ? 'green' : 'amber';
const priorityTagColor = (p: string): 'green' | 'red' | 'amber' | 'gray' => (p === 'high' ? 'red' : p === 'medium' ? 'amber' : 'gray');

export default function SupportTicketsPage() {
  const t = useT();
  const statusLabel: Record<string, string> = {
    open: t.support.statusOpen,
    in_progress: t.support.statusInProgress,
    resolved: t.support.statusResolved,
    closed: t.support.statusClosed,
  };
  const priorityLabel: Record<string, string> = {
    low: t.support.priorityLow,
    medium: t.support.priorityMedium,
    high: t.support.priorityHigh,
  };

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [replyMsg, setReplyMsg] = useState('');

  function load() {
    get<{ tickets: Ticket[] }>('/support/tickets')
      .then((r) => setTickets(r.tickets))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.support.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await post('/support/tickets', { subject, description, priority });
      setSubject('');
      setDescription('');
      setPriority('medium');
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.support.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  function openTicket(id: string) {
    setOpenId(id);
    setDetail(null);
    get<TicketDetail>(`/support/tickets/${id}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof ApiError ? err.message : t.support.ticketLoadFailed));
  }

  async function sendReply(e: FormEvent) {
    e.preventDefault();
    if (!openId || !replyMsg.trim()) return;
    try {
      await post(`/support/tickets/${openId}/reply`, { message: replyMsg });
      setReplyMsg('');
      openTicket(openId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.support.replyFailed);
    }
  }

  async function changeStatus(status: string) {
    if (!openId) return;
    try {
      await patch(`/support/tickets/${openId}`, { status });
      openTicket(openId);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.support.statusUpdateFailed);
    }
  }

  return (
    <div>
      <PageHeader title={t.support.title} subtitle={t.support.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.support.count(tickets.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          <IconPlus /> {t.support.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.support.subject}</th>
                <th>{t.support.priority}</th>
                <th>{t.support.status}</th>
                <th>{t.support.created}</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((tk) => (
                <tr key={tk.id} onClick={() => openTicket(tk.id)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 700 }}>{tk.subject}</td>
                  <td>
                    <Tag color={priorityTagColor(tk.priority)}>{priorityLabel[tk.priority] || tk.priority}</Tag>
                  </td>
                  <td>
                    <Tag color={statusTagColor(tk.status)}>{statusLabel[tk.status] || tk.status}</Tag>
                  </td>
                  <td>{new Date(tk.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
              {tickets.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <div className="empty-state">{t.support.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {openId && detail && (
        <div className="card">
          <div className="card-head">
            <h2>{detail.subject}</h2>
          </div>
          <div className="card-body">
            <div className="muted" style={{ marginBottom: 14 }}>
              {detail.description}
            </div>

            <div className="field" style={{ maxWidth: 200, marginBottom: 14 }}>
              <label>{t.support.status}</label>
              <select value={detail.status} onChange={(e) => changeStatus(e.target.value)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel[s]}
                  </option>
                ))}
              </select>
            </div>

            <div className="hr" />

            <div style={{ marginBottom: 14 }}>
              {detail.replies.map((r) => (
                <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--stone-100)' }}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
                    {r.is_admin_reply ? t.support.supportSide : t.support.youSide} — {new Date(r.created_at).toLocaleString()}
                  </div>
                  <div>{r.message}</div>
                </div>
              ))}
              {detail.replies.length === 0 && <div className="empty-state">{t.support.noReplies}</div>}
            </div>

            <form onSubmit={sendReply} className="form-row">
              <div className="field" style={{ flex: 3 }}>
                <input value={replyMsg} onChange={(e) => setReplyMsg(e.target.value)} placeholder={t.support.writeReply} />
              </div>
              <div className="field" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" type="submit">
                  {t.support.reply}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {open && (
        <Modal
          title={t.support.newItem}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="ticket-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="ticket-form" onSubmit={handleSubmit} className="field-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.support.subject}</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label>{t.support.priority}</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="low">{t.support.priorityLow}</option>
                <option value="medium">{t.support.priorityMedium}</option>
                <option value="high">{t.support.priorityHigh}</option>
              </select>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.support.description}</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} required />
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
