import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { useAuthStore } from '../store/authStore';
import { useServiceCatalogStore, ServiceCategory, ServiceRequestType, ServiceCustomField } from '../store/useServiceCatalogStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import { IconPlus, IconChevronRight } from '../components/Icon';

interface Ticket {
  id: string;
  // MIGRATION_057 — Smart Numbering, [DEPT]-[YYMM]-[XXXX] e.g. IT-2608-0001. Null
  // for a legacy ticket created before this migration ran.
  ticket_number: string | null;
  subject: string;
  status: string;
  priority: string;
  category: string;
  category_id: string | null;
  request_type_id: string | null;
  dynamic_data: Record<string, unknown>;
  assigned_to: string | null;
  created_by: string;
  sla_resolution_due_at: string | null;
  sla_resolution_breached: boolean;
  resolved_at: string | null;
  created_at: string;
}
interface Reply {
  id: string;
  message: string;
  is_admin_reply: boolean;
  is_internal_note: boolean;
  created_at: string;
}
// MIGRATION_056 — mirrors backend/src/utils/itsmApprovals.ts's ItsmApprovalSummary.
// Present (non-null) only for a ticket that has a spawned ITSM approval chain — a
// legacy ticket, or one created while the company was below Gold tier, simply has
// `approval: null` and the whole status block below doesn't render.
interface ApprovalStepDef {
  step_number: number;
  step_label: string;
  step_label_en: string | null;
}
interface ApprovalLogEntry {
  step_number: number;
  action: string;
  comments: string | null;
  action_at: string;
  approver_name: string | null;
}
interface ItsmApprovalSummary {
  id: string;
  status: string;
  current_step: number;
  total_steps: number;
  steps: ApprovalStepDef[];
  log: ApprovalLogEntry[];
  is_pending_approver: boolean;
}
interface TicketDetail extends Ticket {
  description: string;
  replies: Reply[];
  request_type_name?: string;
  request_type_name_en?: string;
  approval?: ItsmApprovalSummary | null;
  // Whether the CURRENTLY LOGGED IN user is allowed to change this ticket's status —
  // admin/manager always, plus an IT-department employee (see
  // supportTickets.controller.ts's canManageTicketStatus()). Drives whether the
  // status field below renders as an editable <select> or a read-only tag.
  can_manage_status: boolean;
}
interface CompanyUser {
  id: string;
  email: string;
  full_name: string | null;
  // MIGRATION_048 — resolved server-side through employee_id -> employees.department_id
  // -> departments (users.controller.ts's list()). Null for a user with no linked
  // employee record, or one whose employee record has no department set.
  department_name: string | null;
  department_name_en: string | null;
}

// MIGRATION_043's original hardcoded category strings — the ONLY thing left
// that still reads t.support.legacyCategory. Tickets filed before the ITSM
// pivot (or that never had a category_id at all) can still carry one of
// these in the plain `category` VARCHAR; MIGRATION_047's own data migration
// backfilled request_type_id onto every ticket that HAD a category_id, so
// this is purely the deepest legacy fallback now, not a form option anymore.
const LEGACY_CATEGORIES = ['general', 'leave', 'grievance', 'document_request', 'payroll', 'it', 'other'] as const;

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const statusTagColor = (s: string): 'green' | 'red' | 'amber' | 'gray' =>
  s === 'open' ? 'green' : s === 'closed' ? 'gray' : s === 'resolved' ? 'green' : 'amber';
const priorityTagColor = (p: string): 'green' | 'red' | 'amber' | 'gray' => (p === 'high' ? 'red' : p === 'medium' ? 'amber' : 'gray');

// ITSM pivot Step 3 — hard cutover (Principal Architect decision: no parallel
// old/new UI). The old flat ticket-create modal + ticket_categories admin
// tab are gone; this page is now the Service Portal (catalog browse ->
// dynamic ticket form) for everyone, and an Agent Queue (filters + extra
// columns) for admin/manager. Managing the catalog itself moved to its own
// Settings page (ServiceCatalogSettingsPage.tsx / /service-catalog) — this
// page only ever READS categories/requestTypes/customFields now.
export default function SupportTicketsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';

  const categories = useServiceCatalogStore((s) => s.categories);
  const requestTypes = useServiceCatalogStore((s) => s.requestTypes);
  const customFields = useServiceCatalogStore((s) => s.customFields);
  const fetchAll = useServiceCatalogStore((s) => s.fetchAll);
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  function localName(item: { name: string; name_en: string | null }): string {
    return lang === 'ar' ? item.name : item.name_en || item.name;
  }

  // request_type_id is the canonical source for every categorized ticket now
  // (MIGRATION_047 backfilled it onto anything that had a category_id) — the
  // plain `category` string is only consulted as the deepest legacy
  // fallback, for a ticket that predates even ticket_categories.
  function ticketTypeLabel(tk: Ticket | TicketDetail): string {
    if ('request_type_name' in tk && tk.request_type_name) {
      return lang === 'ar' ? tk.request_type_name : tk.request_type_name_en || tk.request_type_name;
    }
    if (tk.request_type_id) {
      const match = requestTypes.find((rt) => rt.id === tk.request_type_id);
      if (match) return localName(match);
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
  const [error, setError] = useState<string | null>(null);

  function load() {
    get<{ tickets: Ticket[] }>('/support/tickets')
      .then((r) => setTickets(r.tickets))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.support.loadFailed));
  }
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep-link from ApprovalsInboxPage.tsx's "View details" action — the ticket
  // detail view is in-component state (openId/detail), not a routed page, so
  // /support?ticket=<id> is how an outside page opens a specific ticket here.
  // openTicket() is declared further down but function declarations are
  // hoisted within this component's scope, so this is safe to run first.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const ticketId = searchParams.get('ticket');
    if (ticketId) openTicket(ticketId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Company users — only fetched for admin/manager, used for the Reporter
  // column (resolving created_by) and the Assignee picker/column. A plain
  // employee never sees either, so there's no reason to pull the whole
  // company's user list into their session.
  const [companyUsers, setCompanyUsers] = useState<CompanyUser[]>([]);
  useEffect(() => {
    if (!isManager) return;
    get<{ users: CompanyUser[] }>('/users')
      .then((r) => setCompanyUsers(r.users))
      .catch(() => {});
  }, [isManager]);
  // MIGRATION_048 — "Ahmad Khaled (IT)" instead of a flat, unlabeled name,
  // so an admin/manager can actually tell who's IT/HR/etc. when assigning a
  // ticket. No department shown at all (not even an empty "()") for a user
  // with no linked employee record or no department set on it — that's the
  // common case for the small handful of admin/owner accounts a company
  // starts with, not something to visually flag as broken.
  function departmentSuffix(u: CompanyUser): string {
    const name = lang === 'ar' ? u.department_name : u.department_name_en || u.department_name;
    return name ? ` (${name})` : '';
  }
  function userLabel(id: string | null): string {
    if (!id) return t.support.unassigned;
    const u = companyUsers.find((c) => c.id === id);
    if (!u) return id;
    return `${u.full_name || u.email}${departmentSuffix(u)}`;
  }

  // --- Agent queue filters (admin/manager only; client-side — ticket volume
  // at this scale doesn't warrant round-tripping every filter combination
  // through the API, and the backend's list() filters don't support an
  // "assigned_to IS NULL" query anyway). ---
  const [assignedFilter, setAssignedFilter] = useState<'all' | 'mine' | 'unassigned'>('all');
  const [statusFilter, setStatusFilter] = useState('');
  const [requestTypeFilter, setRequestTypeFilter] = useState('');
  const visibleTickets = useMemo(() => {
    if (!isManager) return tickets;
    return tickets.filter((tk) => {
      if (assignedFilter === 'mine' && tk.assigned_to !== user?.id) return false;
      if (assignedFilter === 'unassigned' && tk.assigned_to !== null) return false;
      if (statusFilter && tk.status !== statusFilter) return false;
      if (requestTypeFilter && tk.request_type_id !== requestTypeFilter) return false;
      return true;
    });
  }, [tickets, isManager, assignedFilter, statusFilter, requestTypeFilter, user?.id]);

  function slaTag(tk: Ticket) {
    if (tk.resolved_at) return <Tag color="green">{statusLabel.resolved}</Tag>;
    if (tk.sla_resolution_breached) return <Tag color="red">{t.support.slaBreached}</Tag>;
    if (!tk.sla_resolution_due_at) return <span className="muted">{t.support.slaNotSet}</span>;
    return <Tag color="green">{t.support.slaOnTrack}</Tag>;
  }

  // --- Portal: catalog browse (category -> request type) -> dynamic form ---
  const [portalOpen, setPortalOpen] = useState(false);
  const [portalStep, setPortalStep] = useState<'category' | 'requestType' | 'form'>('category');
  const [portalCategoryId, setPortalCategoryId] = useState<string | null>(null);
  const [portalRequestTypeId, setPortalRequestTypeId] = useState<string | null>(null);

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [dynamicValues, setDynamicValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function openPortal() {
    setPortalOpen(true);
    setPortalStep('category');
    setPortalCategoryId(null);
    setPortalRequestTypeId(null);
    setSubject('');
    setDescription('');
    setPriority('medium');
    setDynamicValues({});
    setError(null);
  }

  function pickCategory(id: string | null) {
    setPortalCategoryId(id);
    setPortalStep('requestType');
  }
  function pickRequestType(id: string) {
    setPortalRequestTypeId(id);
    setDynamicValues({});
    setPortalStep('form');
  }
  function skipToGeneralRequest() {
    setPortalCategoryId(null);
    setPortalRequestTypeId(null);
    setDynamicValues({});
    setPortalStep('form');
  }

  const fieldsForForm: ServiceCustomField[] = portalRequestTypeId ? customFields.filter((f) => f.request_type_id === portalRequestTypeId) : [];
  const requestTypesForCategory: ServiceRequestType[] = requestTypes.filter((rt) => rt.category_id === portalCategoryId);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Server-side validation (Step 2.5) is the real enforcement — this is
      // just a friendlier pre-check so a missing required field doesn't
      // round-trip to the server just to bounce back with a 400.
      for (const f of fieldsForForm) {
        if (f.is_required && !dynamicValues[f.field_key]?.trim()) {
          throw new ApiError(400, `${lang === 'ar' ? f.field_label : f.field_label_en || f.field_label} (${t.serviceCatalog.isRequiredLabel})`);
        }
      }
      const dynamic_data: Record<string, unknown> = {};
      for (const f of fieldsForForm) {
        const raw = dynamicValues[f.field_key];
        if (raw === undefined || raw === '') continue;
        dynamic_data[f.field_key] = f.field_type === 'number' ? Number(raw) : raw;
      }
      await post('/support/tickets', {
        subject,
        description,
        priority,
        ...(portalRequestTypeId ? { request_type_id: portalRequestTypeId, dynamic_data } : {}),
      });
      setPortalOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.support.saveFailed);
    } finally {
      setSubmitting(false);
    }
  }

  // --- Ticket detail ---
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [replyMsg, setReplyMsg] = useState('');
  const [markInternal, setMarkInternal] = useState(false);

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

  async function changeAssignee(assigned_to: string) {
    if (!openId) return;
    try {
      await patch(`/support/tickets/${openId}`, { assigned_to: assigned_to || null });
      openTicket(openId);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.support.assignFailed);
    }
  }

  // --- MIGRATION_056: Approval Workflow Status block ---
  // Reuses the SAME endpoint the Approvals Inbox uses (POST /approvals/:id/action) —
  // no separate ticket-scoped approval endpoint, this page is just another caller.
  // Approve goes through a small optional-comment modal; Reject is a one-click
  // confirm(), matching ApprovalsInboxPage.tsx's own UX split.
  const [approvalCommentOpen, setApprovalCommentOpen] = useState(false);
  const [approvalComment, setApprovalComment] = useState('');
  const [approvalActing, setApprovalActing] = useState(false);

  async function submitTicketApproval(action: 'approved' | 'rejected', comments?: string) {
    if (!detail?.approval) return;
    setApprovalActing(true);
    setError(null);
    try {
      await post(`/approvals/${detail.approval.id}/action`, { action, comments: comments?.trim() || undefined });
      setApprovalCommentOpen(false);
      setApprovalComment('');
      if (openId) openTicket(openId);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.approvals.actionFailed);
    } finally {
      setApprovalActing(false);
    }
  }

  function handleTicketApprovalReject() {
    if (!confirm(t.approvals.rejectConfirm)) return;
    submitTicketApproval('rejected');
  }

  function approvalStatusTag(status: string) {
    if (status === 'approved') return <Tag color="green">{t.approvals.statusApproved}</Tag>;
    if (status === 'rejected') return <Tag color="red">{t.approvals.statusRejected}</Tag>;
    return <Tag color="amber">{t.approvals.statusPending}</Tag>;
  }

  // dynamic_data key -> the field's own definition, when it still exists
  // (a field can be deleted after tickets were filed against it — the value
  // stays on the ticket, just falls back to the raw key as its label).
  function fieldDefFor(key: string): ServiceCustomField | undefined {
    return customFields.find((f) => f.field_key === key && f.request_type_id === detail?.request_type_id);
  }

  return (
    <div>
      <PageHeader title={t.support.title} subtitle={t.support.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.support.count(visibleTickets.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openPortal}>
          <IconPlus /> {t.support.newItem}
        </button>
      </div>

      {isManager && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
            <div className="field" style={{ maxWidth: 200 }}>
              <label>{t.support.assignee}</label>
              <select value={assignedFilter} onChange={(e) => setAssignedFilter(e.target.value as typeof assignedFilter)}>
                <option value="all">{t.support.filterAll}</option>
                <option value="mine">{t.support.filterAssignedToMe}</option>
                <option value="unassigned">{t.support.filterUnassigned}</option>
              </select>
            </div>
            <div className="field" style={{ maxWidth: 180 }}>
              <label>{t.support.status}</label>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">{t.support.filterAnyStatus}</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ maxWidth: 220 }}>
              <label>{t.support.requestType}</label>
              <select value={requestTypeFilter} onChange={(e) => setRequestTypeFilter(e.target.value)}>
                <option value="">{t.support.filterAnyRequestType}</option>
                {requestTypes.map((rt) => (
                  <option key={rt.id} value={rt.id}>
                    {localName(rt)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.support.subject}</th>
                {isManager && <th>{t.support.reporter}</th>}
                {isManager && <th>{t.support.assignee}</th>}
                <th>{t.support.requestType}</th>
                <th>{t.support.priority}</th>
                <th>{t.support.status}</th>
                {isManager && <th>{t.support.timeToResolution}</th>}
                <th>{t.support.created}</th>
              </tr>
            </thead>
            <tbody>
              {visibleTickets.map((tk) => (
                <tr key={tk.id} onClick={() => openTicket(tk.id)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 700 }}>
                    {tk.ticket_number && (
                      <span className="muted" style={{ fontWeight: 400, fontSize: 11, display: 'block' }}>
                        {tk.ticket_number}
                      </span>
                    )}
                    {tk.subject}
                  </td>
                  {isManager && <td className="muted">{userLabel(tk.created_by)}</td>}
                  {isManager && <td className="muted">{userLabel(tk.assigned_to)}</td>}
                  <td className="muted">{ticketTypeLabel(tk)}</td>
                  <td>
                    <Tag color={priorityTagColor(tk.priority)}>{priorityLabel[tk.priority] || tk.priority}</Tag>
                  </td>
                  <td>
                    <Tag color={statusTagColor(tk.status)}>{statusLabel[tk.status] || tk.status}</Tag>
                  </td>
                  {isManager && <td>{slaTag(tk)}</td>}
                  <td>{new Date(tk.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
              {visibleTickets.length === 0 && (
                <tr>
                  <td colSpan={isManager ? 8 : 5}>
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
            <h2>
              {detail.ticket_number && (
                <span className="muted" style={{ fontWeight: 500, fontSize: 13, marginInlineEnd: 8 }}>
                  {detail.ticket_number}
                </span>
              )}
              {detail.subject}
            </h2>
          </div>
          <div className="card-body">
            {/* Original ticket content — subject is already the card-head <h2> above;
                this is the description/body the requester actually typed. Rendered
                first, in its own visually distinct card, so an approver can read
                what's actually being asked BEFORE the Approval Workflow block below —
                previously this rendered as a single unstyled muted <div> further down
                the page (past the approval block), easy to miss entirely. */}
            <div className="card" style={{ background: 'var(--surface-alt)', border: '1px solid var(--border)', marginBottom: 14 }}>
              <div className="card-body" style={{ padding: 14 }}>
                <div className="muted" style={{ fontSize: 11, fontWeight: 700, marginBottom: 8 }}>
                  {t.support.description}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word', lineHeight: 1.6 }}>
                  {detail.description || <span className="muted">{t.support.noDescription}</span>}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                  {t.support.requestType}: {ticketTypeLabel(detail)}
                </div>
              </div>
            </div>

            {/* MIGRATION_056 — Approval Workflow Status, top of the ticket per spec.
                Absent entirely (detail.approval is null) for a legacy ticket or one
                created while the company was below Gold tier. */}
            {detail.approval && (
              <div className="card" style={{ background: 'var(--surface-alt)', marginBottom: 14 }}>
                <div className="card-body" style={{ padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <span style={{ fontWeight: 800, fontSize: 13 }}>{t.support.approvalTitle}</span>
                    {approvalStatusTag(detail.approval.status)}
                  </div>

                  {detail.approval.status === 'pending' &&
                    (() => {
                      const step = detail.approval!.steps.find((s) => s.step_number === detail.approval!.current_step);
                      if (!step) return null;
                      const stepLabel = lang === 'ar' ? step.step_label : step.step_label_en || step.step_label;
                      return (
                        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                          {t.support.approvalStepOf(detail.approval!.current_step, detail.approval!.total_steps)} — {stepLabel}
                        </div>
                      );
                    })()}

                  {detail.approval.log.length > 0 && (
                    <div style={{ marginBottom: detail.approval.is_pending_approver ? 10 : 0 }}>
                      <div className="muted" style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
                        {t.support.approvalHistoryTitle}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {detail.approval.log.map((entry, i) => (
                          <div key={i} className="muted" style={{ fontSize: 12 }}>
                            {entry.approver_name || '—'} — {approvalStatusTag(entry.action)}
                            {entry.comments && <span> — {entry.comments}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {detail.approval.status === 'pending' && detail.approval.is_pending_approver && (
                    <>
                      <div className="muted" style={{ fontSize: 12, marginBottom: 8, fontWeight: 600 }}>
                        {t.support.approvalYourTurn}
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={approvalActing}
                          onClick={() => {
                            setApprovalComment('');
                            setApprovalCommentOpen(true);
                          }}
                        >
                          {t.approvals.approve}
                        </button>
                        <button className="btn btn-danger btn-sm" disabled={approvalActing} onClick={handleTicketApprovalReject}>
                          {t.approvals.reject}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* dynamic_data — shown above the reply thread, per the ITSM
                portal spec. Falls back to the raw key/value when a field's
                own definition was since deleted. */}
            {Object.keys(detail.dynamic_data || {}).length > 0 && (
              <div className="card" style={{ background: 'var(--surface-alt)', marginBottom: 14 }}>
                <div className="card-body" style={{ padding: 12 }}>
                  <div className="muted" style={{ fontSize: 11, fontWeight: 700, marginBottom: 8 }}>
                    {t.support.additionalDetails}
                  </div>
                  <div className="field-grid">
                    {Object.entries(detail.dynamic_data).map(([key, value]) => {
                      const def = fieldDefFor(key);
                      const label = def ? (lang === 'ar' ? def.field_label : def.field_label_en || def.field_label) : key;
                      return (
                        <div key={key}>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {label}
                          </div>
                          <div style={{ fontWeight: 600 }}>{String(value)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            <div className="form-row" style={{ marginBottom: 14 }}>
              <div className="field" style={{ maxWidth: 200 }}>
                <label>{t.support.status}</label>
                {detail.can_manage_status ? (
                  <select value={detail.status} onChange={(e) => changeStatus(e.target.value)}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {statusLabel[s]}
                      </option>
                    ))}
                  </select>
                ) : (
                  // Only IT staff, managers, and admins can move a ticket through its
                  // status lifecycle (see canManageTicketStatus() on the backend) —
                  // everyone else, including the ticket's own requester, sees a
                  // read-only tag instead of an editable dropdown.
                  <div style={{ paddingTop: 4 }}>
                    <Tag color={statusTagColor(detail.status)}>{statusLabel[detail.status] || detail.status}</Tag>
                  </div>
                )}
              </div>
              {isManager && (
                <div className="field" style={{ maxWidth: 220 }}>
                  <label>{t.support.assignee}</label>
                  <select value={detail.assigned_to || ''} onChange={(e) => changeAssignee(e.target.value)}>
                    <option value="">{t.support.assignTo}</option>
                    {companyUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.full_name || u.email}
                        {departmentSuffix(u)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
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

      {portalOpen && (
        <Modal
          title={
            portalStep === 'category'
              ? t.support.portalTitle
              : portalStep === 'requestType'
              ? categories.find((c) => c.id === portalCategoryId)
                ? localName(categories.find((c) => c.id === portalCategoryId) as ServiceCategory)
                : t.support.portalTitle
              : t.support.newItem
          }
          onClose={() => setPortalOpen(false)}
          actions={
            portalStep === 'form'
              ? (requestClose) => (
                  <>
                    <button className="btn btn-primary" type="submit" form="ticket-form" disabled={submitting}>
                      {submitting ? t.common.loading : t.common.save}
                    </button>
                    <button className="btn btn-secondary" type="button" onClick={requestClose}>
                      {t.common.cancel}
                    </button>
                  </>
                )
              : undefined
          }
        >
          {portalStep === 'category' && (
            <div>
              <p className="muted" style={{ marginBottom: 14 }}>
                {t.support.portalHint}
              </p>
              {categories.length === 0 ? (
                <div className="empty-state">{t.support.noCategoriesYet}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {categories.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="btn btn-secondary"
                      style={{ justifyContent: 'space-between', width: '100%' }}
                      onClick={() => pickCategory(c.id)}
                    >
                      <span>{localName(c)}</span>
                      <IconChevronRight />
                    </button>
                  ))}
                </div>
              )}
              <div className="hr" style={{ margin: '14px 0' }} />
              <button type="button" className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center' }} onClick={skipToGeneralRequest}>
                {t.support.noRequestType}
              </button>
            </div>
          )}

          {portalStep === 'requestType' && (
            <div>
              <button type="button" className="btn btn-secondary btn-sm" style={{ marginBottom: 14 }} onClick={() => setPortalStep('category')}>
                ← {t.support.backToCategories}
              </button>
              {requestTypesForCategory.length === 0 ? (
                <div className="empty-state">{t.support.noRequestTypesInCategory}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {requestTypesForCategory.map((rt) => (
                    <button
                      key={rt.id}
                      type="button"
                      className="btn btn-secondary"
                      style={{ justifyContent: 'space-between', width: '100%' }}
                      onClick={() => pickRequestType(rt.id)}
                    >
                      <span>{localName(rt)}</span>
                      <IconChevronRight />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {portalStep === 'form' && (
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

              {/* Form Renderer — one input per service_custom_fields row for
                  the chosen request type. `dropdown` has no options list in
                  the schema yet (MIGRATION_047 didn't add one — documented in
                  supportTickets.controller.ts's validateDynamicData()), so it
                  renders as a plain text input for now, same as `text`. */}
              {fieldsForForm.length > 0 && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <div className="hr" style={{ margin: '4px 0 12px' }} />
                  <div className="muted" style={{ fontSize: 11, fontWeight: 700, marginBottom: 8 }}>
                    {t.support.additionalDetails}
                  </div>
                </div>
              )}
              {fieldsForForm.map((f) => {
                const fieldLabel = lang === 'ar' ? f.field_label : f.field_label_en || f.field_label;
                const value = dynamicValues[f.field_key] ?? '';
                const setValue = (v: string) => setDynamicValues((d) => ({ ...d, [f.field_key]: v }));
                return (
                  <div className="field" key={f.id} style={f.field_type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
                    <label>
                      {fieldLabel}
                      {f.is_required && <span style={{ color: 'var(--danger)' }}> *</span>}
                    </label>
                    {f.field_type === 'textarea' ? (
                      <textarea value={value} onChange={(e) => setValue(e.target.value)} required={f.is_required} />
                    ) : f.field_type === 'number' ? (
                      <input type="number" className="num" value={value} onChange={(e) => setValue(e.target.value)} required={f.is_required} />
                    ) : (
                      <input value={value} onChange={(e) => setValue(e.target.value)} required={f.is_required} />
                    )}
                  </div>
                );
              })}
            </form>
          )}
        </Modal>
      )}

      {approvalCommentOpen && (
        <Modal
          title={t.approvals.commentModalTitle}
          onClose={() => setApprovalCommentOpen(false)}
          actions={
            <>
              <button className="btn btn-primary" type="button" disabled={approvalActing} onClick={() => submitTicketApproval('approved', approvalComment)}>
                {approvalActing ? t.common.loading : t.approvals.confirmApprove}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setApprovalCommentOpen(false)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <div className="field">
            <label>{t.approvals.commentLabel}</label>
            <textarea rows={3} value={approvalComment} onChange={(e) => setApprovalComment(e.target.value)} placeholder={t.approvals.commentPlaceholder} />
          </div>
        </Modal>
      )}
    </div>
  );
}
