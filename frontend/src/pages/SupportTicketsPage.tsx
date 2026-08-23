import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { useAuthStore } from '../store/authStore';
import { useTicketCategoriesStore, TicketCategory } from '../store/useTicketCategoriesStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import { IconPlus } from '../components/Icon';

interface Ticket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  category_id: string | null;
  created_at: string;
}
interface Reply {
  id: string;
  message: string;
  is_admin_reply: boolean;
  is_internal_note: boolean;
  created_at: string;
}
interface TicketDetail extends Ticket {
  description: string;
  replies: Reply[];
}

// Mirrors supportTickets.controller.ts's CATEGORIES array (MIGRATION_043) —
// the create-form's fallback when /api/ticket-categories has nothing yet
// (empty company, or the request failed). Real per-company categories from
// MIGRATION_046 are preferred whenever there's at least one.
const LEGACY_CATEGORIES = ['general', 'leave', 'grievance', 'document_request', 'payroll', 'it', 'other'] as const;

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const statusTagColor = (s: string): 'green' | 'red' | 'amber' | 'gray' =>
  s === 'open' ? 'green' : s === 'closed' ? 'gray' : s === 'resolved' ? 'green' : 'amber';
const priorityTagColor = (p: string): 'green' | 'red' | 'amber' | 'gray' => (p === 'high' ? 'red' : p === 'medium' ? 'amber' : 'gray');

export default function SupportTicketsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const user = useAuthStore((s) => s.user);
  // Same admin/manager check PolicyDetailsModal uses for its own role-gated
  // section — no separate macrocore support-staff role exists in this schema
  // yet (see supportTickets.controller.ts's reply()).
  const isManager = user?.role === 'admin' || user?.role === 'manager';

  const categories = useTicketCategoriesStore((s) => s.categories);
  const fetchCategories = useTicketCategoriesStore((s) => s.fetchCategories);
  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);
  const hasDynamicCategories = categories.length > 0;

  function categoryName(cat: TicketCategory): string {
    return lang === 'ar' ? cat.name : cat.name_en || cat.name;
  }
  // Backward compatibility (Step 3, item 4): category_id wins when a ticket has
  // one; older tickets (or ones created before this company had any
  // ticket_categories rows) fall back to the legacy `category` string, which
  // the backend always sets regardless (defaults to 'general').
  function ticketCategoryLabel(tk: Ticket): string {
    if (tk.category_id) {
      const match = categories.find((c) => c.id === tk.category_id);
      if (match) return categoryName(match);
    }
    return t.support.legacyCategory[tk.category as keyof typeof t.support.legacyCategory] ?? tk.category;
  }

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
  const [categoryId, setCategoryId] = useState('');
  const [legacyCategory, setLegacyCategory] = useState<string>('general');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [replyMsg, setReplyMsg] = useState('');
  const [markInternal, setMarkInternal] = useState(false);

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
      await post('/support/tickets', {
        subject,
        description,
        priority,
        // Exactly one of the two, matching whichever mode the form is in —
        // sending category_id from a stale/mismatched form state a company
        // doesn't have would just get rejected by the backend's own
        // cross-tenant check for no benefit.
        ...(hasDynamicCategories ? { category_id: categoryId || undefined } : { category: legacyCategory }),
      });
      setSubject('');
      setDescription('');
      setPriority('medium');
      setCategoryId('');
      setLegacyCategory('general');
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
      // Only sent at all when isManager — an employee's client never even
      // offers the checkbox (see the reply form below), and the backend
      // downgrades it to false anyway if it somehow arrived (defense in
      // depth, not something the UI needs to duplicate).
      await post(`/support/tickets/${openId}/reply`, {
        message: replyMsg,
        ...(isManager ? { is_internal_note: markInternal } : {}),
      });
      setReplyMsg('');
      setMarkInternal(false);
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
                <th>{t.support.category}</th>
                <th>{t.support.priority}</th>
                <th>{t.support.status}</th>
                <th>{t.support.created}</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((tk) => (
                <tr key={tk.id} onClick={() => openTicket(tk.id)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 700 }}>{tk.subject}</td>
                  <td className="muted">{ticketCategoryLabel(tk)}</td>
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
                  <td colSpan={5}>
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

            <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
              {t.support.category}: {ticketCategoryLabel(detail)}
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

            <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {detail.replies.map((r) => (
                <div
                  key={r.id}
                  className={r.is_internal_note ? 'reply-internal-note' : undefined}
                  style={{ padding: '8px 0', borderBottom: r.is_internal_note ? 'none' : '1px solid var(--stone-100)' }}
                >
                  <div className="muted" style={{ fontSize: 11, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>
                      {r.is_admin_reply ? t.support.supportSide : t.support.youSide} — {new Date(r.created_at).toLocaleString()}
                    </span>
                    {r.is_internal_note && <Tag color="amber">{t.support.internalNote}</Tag>}
                  </div>
                  <div>{r.message}</div>
                </div>
              ))}
              {detail.replies.length === 0 && <div className="empty-state">{t.support.noReplies}</div>}
            </div>

            <form onSubmit={sendReply}>
              <div className="form-row">
                <div className="field" style={{ flex: 3 }}>
                  <input value={replyMsg} onChange={(e) => setReplyMsg(e.target.value)} placeholder={t.support.writeReply} />
                </div>
                <div className="field" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn btn-primary" type="submit">
                    {t.support.reply}
                  </button>
                </div>
              </div>
              {/* Role-based rendering: a standard employee never sees this at all
                  (not just disabled) — matches how PolicyDetailsModal gates its
                  own admin/manager-only roles section. */}
              {isManager && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginTop: 8 }}>
                  <input type="checkbox" checked={markInternal} onChange={(e) => setMarkInternal(e.target.checked)} style={{ width: 'auto' }} />
                  <span style={{ fontSize: 13 }}>{t.support.markAsInternalNote}</span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {t.support.internalNoteHint}
                  </span>
                </label>
              )}
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
            <div className="field">
              <label>{t.support.category}</label>
              {hasDynamicCategories ? (
                <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">{t.support.noCategory}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {categoryName(c)}
                    </option>
                  ))}
                </select>
              ) : (
                // Fallback (Step 3, item 2): ticket_categories is empty or
                // failed to load — degrade to the legacy hardcoded list rather
                // than leaving the form without a category field at all.
                <select value={legacyCategory} onChange={(e) => setLegacyCategory(e.target.value)}>
                  {LEGACY_CATEGORIES.map((key) => (
                    <option key={key} value={key}>
                      {t.support.legacyCategory[key]}
                    </option>
                  ))}
                </select>
              )}
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
