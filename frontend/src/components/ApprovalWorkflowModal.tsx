import { Fragment, useEffect, useState } from 'react';
import { get, post, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import Modal from './Modal';
import ConfirmDialog from './ConfirmDialog';
import Tag from './Tag';
import { IconPaperclip, IconClose } from './Icon';
import { Attachment, AttachmentGallery, readFileAsBase64, addStagedFiles } from './Attachments';

// Shared "Approval status" popup — opened by clicking any approval status tag in
// ExpensesPage/PayrollPage/PurchaseOrdersPage/ApprovalsInboxPage. Shows the request's
// own details (passed in by the caller, who already has the row loaded) plus a
// vertical timeline of the approval workflow (submitted -> each step -> outcome),
// fetched from the one shared GET /api/approvals/summary endpoint that generalizes
// across single-step financial modules and ITSM_TICKET's real multi-step chain.
//
// Built as a vertical timeline rather than a horizontal "from -> to -> to" row of
// chips on purpose: a horizontal arrow's direction reads backwards once the page
// flips to RTL Arabic, while a top-to-bottom timeline (dot + connecting line, like a
// shipment tracker) reads identically in both languages and still shows the exact
// same "where is it now / what's next" information.
//
// Originally read-only by design — approve/reject stayed on their existing surfaces
// (the Approvals Inbox, or SupportTicketsPage's own ticket detail). Real usage showed
// that was one click too many: an eligible approver would open this popup to see
// exactly what they need to decide, then have to close it and go hunt for the action
// elsewhere. So when the viewer IS the pending approver (is_pending_approver) and the
// request is still pending, this popup now also lets them act — reusing the exact
// same POST /approvals/:id/action endpoint and inline-comment-then-confirm pattern
// SupportTicketsPage.tsx already uses for ITSM tickets, generalized here to work for
// every module_type this endpoint supports. onActioned lets the caller refresh its own
// list (the row's status just changed) — it does NOT auto-close the popup, so the
// viewer sees the timeline update to reflect their own decision before dismissing it.
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
  // MIGRATION_062 — a return/resubmit decision can carry the actual fix (a
  // corrected receipt photo, an updated document), not just a comment.
  attachments: Attachment[];
  approver_name: string | null;
}
interface RecordDetailLine {
  label_ar: string;
  label_en: string;
  value: string;
}
interface ApprovalSummary {
  id: string;
  module_type: string;
  // MIGRATION_060 -- human-readable request number (e.g. APR-2608-0001), shown in
  // this modal's own title so it always reads the same as the bell notification and
  // the Approvals Inbox row it corresponds to.
  request_number: string | null;
  status: string;
  current_step: number;
  total_steps: number;
  requester_name: string | null;
  requester_job_role: string | null;
  steps: ApprovalStepDef[];
  log: ApprovalLogEntry[];
  is_pending_approver: boolean;
  // MIGRATION_061 -- true only for the maker themselves, only while the request is
  // sitting "with them" (status === 'returned'). Drives the returned-banner +
  // Resubmit button below.
  can_resubmit: boolean;
  // Server-computed fallback for callers that don't already have the record loaded
  // (ApprovalsInboxPage passes detailLines={[]} for exactly this reason) -- see
  // approvals.controller.ts's buildRecordDetail().
  record_detail: RecordDetailLine[];
}

type NodeState = 'done' | 'current' | 'upcoming' | 'rejected';

interface Props {
  moduleType: string;
  referenceId: string;
  // Small key/value list the CALLER builds from data it already has loaded (amount,
  // category, employee name, supplier, etc.) — this endpoint only ever returns
  // workflow data, never re-fetches the underlying record itself.
  detailLines: { label: string; value: string }[];
  onClose: () => void;
  // Called after a successful approve/reject so the caller (whichever list page
  // opened this popup) can refresh its own rows. Optional — pass the page's own
  // load()/refetch function so acting from inside the popup doesn't leave that page
  // showing a stale row.
  onActioned?: () => void;
}

const DOT_COLOR: Record<NodeState, string> = {
  done: '#22c55e',
  current: '#f5a623',
  upcoming: '#d6d3d1',
  rejected: '#dc2626',
};

export default function ApprovalWorkflowModal({ moduleType, referenceId, detailLines, onClose, onActioned }: Props) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const [summary, setSummary] = useState<ApprovalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Inline approve/reject — approving opens a small optional-comment step (matching
  // SupportTicketsPage.tsx's own approvalCommentOpen/approvalComment pattern);
  // rejecting confirms once via window.confirm(), same as ApprovalsInboxPage's
  // quick-reject button, then submits immediately with no comment.
  const [approving, setApproving] = useState(false);
  const [comment, setComment] = useState('');
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingReject, setConfirmingReject] = useState(false);
  // MIGRATION_061 — "Modify" (Return for Changes): a separate flow from Approve's
  // optional comment, since here the comment is mandatory (the whole point is
  // telling the maker what to fix). "Resubmit" needs only a plain confirm — the
  // maker isn't leaving a note, they're just sending their fix back.
  const [modifying, setModifying] = useState(false);
  const [modifyComment, setModifyComment] = useState('');
  const [modifyFiles, setModifyFiles] = useState<File[]>([]);
  // MIGRATION_062 — Resubmit is now a small form too (comment optional + attachments
  // optional), not a bare confirm: the maker needs somewhere to actually attach the
  // fix, not just click a button with nothing to show for it.
  const [resubmitting, setResubmitting] = useState(false);
  const [resubmitComment, setResubmitComment] = useState('');
  const [resubmitFiles, setResubmitFiles] = useState<File[]>([]);

  function loadSummary() {
    setLoading(true);
    setError(null);
    get<{ summary: ApprovalSummary | null }>(
      `/approvals/summary?module_type=${encodeURIComponent(moduleType)}&reference_id=${encodeURIComponent(referenceId)}`
    )
      .then((r) => setSummary(r.summary))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.approvalWorkflow.loadFailed))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleType, referenceId]);

  async function submitAction(action: 'approved' | 'rejected' | 'returned' | 'resubmitted', comments?: string, files?: File[]) {
    if (!summary) return;
    setActing(true);
    setActionError(null);
    try {
      const attachments = files && files.length > 0 ? await Promise.all(files.map(async (f) => ({ file_name: f.name, file_base64: await readFileAsBase64(f) }))) : undefined;
      await post(`/approvals/${summary.id}/action`, { action, comments: comments?.trim() || undefined, attachments });
      setApproving(false);
      setComment('');
      setModifying(false);
      setModifyComment('');
      setModifyFiles([]);
      setResubmitting(false);
      setResubmitComment('');
      setResubmitFiles([]);
      loadSummary();
      onActioned?.();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t.approvals.actionFailed);
    } finally {
      setActing(false);
    }
  }

  function handleReject() {
    setConfirmingReject(true);
  }

  function confirmReject() {
    setConfirmingReject(false);
    submitAction('rejected');
  }

  function confirmModify() {
    if (!modifyComment.trim()) {
      setActionError(t.approvals.modifyCommentRequired);
      return;
    }
    submitAction('returned', modifyComment, modifyFiles);
  }

  function addModifyFiles(files: FileList | null) {
    setActionError(null);
    const next = addStagedFiles(modifyFiles, files, (msg) => setActionError(msg), t.approvals.attachmentTooLarge, t.approvals.tooManyAttachments);
    if (next) setModifyFiles(next);
  }
  function removeModifyFile(index: number) {
    setModifyFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function confirmResubmit() {
    submitAction('resubmitted', resubmitComment, resubmitFiles);
  }

  function addResubmitFiles(files: FileList | null) {
    setActionError(null);
    const next = addStagedFiles(resubmitFiles, files, (msg) => setActionError(msg), t.approvals.attachmentTooLarge, t.approvals.tooManyAttachments);
    if (next) setResubmitFiles(next);
  }
  function removeResubmitFile(index: number) {
    setResubmitFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function stepLabel(s: ApprovalStepDef) {
    return lang === 'ar' ? s.step_label : s.step_label_en || s.step_label;
  }

  function outcomeTag(status: string) {
    if (status === 'approved') return <Tag color="green">{t.approvals.statusApproved}</Tag>;
    if (status === 'rejected') return <Tag color="red">{t.approvals.statusRejected}</Tag>;
    if (status === 'cancelled') return <Tag color="gray">{t.approvals.statusCancelled}</Tag>;
    if (status === 'returned') return <Tag color="amber">{t.approvals.statusReturned}</Tag>;
    return <Tag color="amber">{t.approvals.statusPending}</Tag>;
  }

  const moduleLabel = (t.approvals.moduleLabels as Record<string, string>)[moduleType] ?? moduleType;

  const timelineNodes: { key: string; label: string; state: NodeState; meta?: string; attachments?: Attachment[] }[] = [];
  if (summary) {
    timelineNodes.push({
      key: 'submitted',
      label: summary.requester_name ? `${t.approvalWorkflow.submittedByLabel}: ${summary.requester_name}` : t.approvalWorkflow.submittedByLabel,
      state: 'done',
    });

    summary.steps.forEach((s) => {
      const log = summary.log.find((l) => l.step_number === s.step_number);
      let state: NodeState;
      if (summary.status === 'approved') state = 'done';
      else if (summary.status === 'rejected') {
        if (s.step_number < summary.current_step) state = 'done';
        else if (s.step_number === summary.current_step) state = 'rejected';
        else state = 'upcoming';
      } else if (s.step_number < summary.current_step) state = 'done';
      else if (s.step_number === summary.current_step) state = 'current';
      else state = 'upcoming';

      let meta: string | undefined;
      if (log) {
        const when = new Date(log.action_at).toLocaleDateString(lang === 'ar' ? 'ar' : 'en');
        meta = `${log.approver_name || '—'} · ${when}`;
        if (log.comments) meta += ` — ${log.comments}`;
      }
      timelineNodes.push({ key: `step-${s.step_number}`, label: stepLabel(s), state, meta, attachments: log?.attachments });
    });

    timelineNodes.push({
      key: 'outcome',
      label:
        summary.status === 'approved'
          ? t.approvals.statusApproved
          : summary.status === 'rejected'
            ? t.approvals.statusRejected
            : summary.status === 'returned'
              ? t.approvals.statusReturned
              : t.approvalWorkflow.finalDecisionLabel,
      state:
        summary.status === 'approved'
          ? 'done'
          : summary.status === 'rejected'
            ? 'rejected'
            : summary.status === 'returned'
              ? 'current'
              : 'upcoming',
    });
  }

  return (
    <Fragment>
    <Modal
      title={summary?.request_number ? `${t.approvalWorkflow.title} — ${moduleLabel} #${summary.request_number}` : `${t.approvalWorkflow.title} — ${moduleLabel}`}
      onClose={onClose}
      actions={
        <button className="btn btn-secondary" type="button" onClick={onClose}>
          {t.common.close}
        </button>
      }
    >
      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="muted">{t.common.loading}</div>}

      {/* Caller-supplied detailLines take priority (pages that already have the row
          loaded render instantly, no network wait) -- record_detail from the summary
          fetch is only the fallback for a caller with nothing preloaded, currently
          ApprovalsInboxPage's eye icon. */}
      {!loading && (detailLines.length > 0 || (summary?.record_detail.length ?? 0) > 0) && (
        <>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)', marginBottom: 8 }}>{t.approvalWorkflow.detailsTitle}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', marginBottom: 18, fontSize: 13 }}>
            {detailLines.length > 0
              ? detailLines.map((d) => (
                  <div key={d.label} style={{ display: 'contents' }}>
                    <span className="muted">{d.label}</span>
                    <span style={{ fontWeight: 700 }}>{d.value}</span>
                  </div>
                ))
              : summary?.record_detail.map((d) => (
                  <div key={d.label_en} style={{ display: 'contents' }}>
                    <span className="muted">{lang === 'ar' ? d.label_ar : d.label_en}</span>
                    <span style={{ fontWeight: 700 }}>{d.value}</span>
                  </div>
                ))}
          </div>
        </>
      )}

      {!loading && !summary && <div className="empty-state">{t.approvalWorkflow.notFound}</div>}

      {!loading && summary && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.approvalWorkflow.timelineTitle}</span>
            {outcomeTag(summary.status)}
          </div>
          <div>
            {timelineNodes.map((node, i) => (
              <div key={node.key} style={{ display: 'flex', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: DOT_COLOR[node.state],
                      flexShrink: 0,
                      marginTop: 3,
                      boxShadow: node.state === 'current' ? '0 0 0 4px rgba(245,166,35,0.25)' : undefined,
                    }}
                  />
                  {i < timelineNodes.length - 1 && <span style={{ width: 2, flex: 1, minHeight: 22, background: '#e7e5e4' }} />}
                </div>
                <div style={{ paddingBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: node.state === 'current' ? 800 : 600 }}>{node.label}</div>
                  {node.meta && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {node.meta}
                    </div>
                  )}
                  {node.attachments && node.attachments.length > 0 && <AttachmentGallery attachments={node.attachments} />}
                  {node.state === 'current' && (
                    <div style={{ fontSize: 11, color: '#b45309', marginTop: 2, fontWeight: 700 }}>{t.approvalWorkflow.waitingOnLabel}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {summary.status === 'pending' && summary.is_pending_approver && (
            <div style={{ marginTop: 4, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              {actionError && <div className="error-banner">{actionError}</div>}
              <div style={{ fontSize: 12, fontWeight: 700, color: '#b45309', marginBottom: 8 }}>{t.approvalWorkflow.yourTurnLabel}</div>
              {!approving && !modifying ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary btn-sm" type="button" disabled={acting} onClick={() => setApproving(true)}>
                    {t.approvals.approve}
                  </button>
                  {/* MIGRATION_061 — "Modify" sits between Approve and Reject: the
                      approver's third option, sending the request back to the maker
                      for changes instead of an outright accept/decline. */}
                  <button className="btn btn-secondary btn-sm" type="button" disabled={acting} onClick={() => setModifying(true)}>
                    {t.approvals.modify}
                  </button>
                  <button className="btn btn-danger btn-sm" type="button" disabled={acting} onClick={handleReject}>
                    {t.approvals.reject}
                  </button>
                </div>
              ) : approving ? (
                <div>
                  <div className="field">
                    <label>{t.approvals.commentLabel}</label>
                    <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t.approvals.commentPlaceholder} />
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-primary btn-sm" type="button" disabled={acting} onClick={() => submitAction('approved', comment)}>
                      {acting ? t.common.loading : t.approvals.confirmApprove}
                    </button>
                    <button className="btn btn-secondary btn-sm" type="button" disabled={acting} onClick={() => setApproving(false)}>
                      {t.common.cancel}
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>{t.approvals.modifyConfirmTitle}</div>
                  <div className="field">
                    <label>{t.approvals.modifyCommentLabel}</label>
                    <textarea
                      rows={5}
                      value={modifyComment}
                      onChange={(e) => setModifyComment(e.target.value)}
                      placeholder={t.approvals.modifyCommentPlaceholder}
                      style={{ fontSize: 14, lineHeight: 1.5, padding: 10 }}
                    />
                  </div>
                  <div className="field">
                    <label>{t.approvals.attachments}</label>
                    <label className="btn btn-secondary btn-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', width: 'fit-content' }}>
                      <IconPaperclip size={14} /> {t.approvals.addAttachment}
                      <input type="file" multiple style={{ display: 'none' }} onChange={(e) => addModifyFiles(e.target.files)} />
                    </label>
                    {modifyFiles.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                        {modifyFiles.map((f, i) => (
                          <div key={`${f.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                            <button type="button" className="icon-btn" title={t.approvals.removeAttachment} onClick={() => removeModifyFile(i)}>
                              <IconClose size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-primary btn-sm" type="button" disabled={acting} onClick={confirmModify}>
                      {acting ? t.common.loading : t.approvals.confirmModify}
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      disabled={acting}
                      onClick={() => {
                        setModifying(false);
                        setModifyComment('');
                        setModifyFiles([]);
                        setActionError(null);
                      }}
                    >
                      {t.common.cancel}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* MIGRATION_061/062 — the maker's own side of "Return for Changes": shown
              only to them (can_resubmit is server-computed from viewer identity +
              status === 'returned'), regardless of whether they'd also be the
              pending approver on some other request. The reviewer's comment gets a
              large, comfortable box (not the cramped one-liner it used to be), and
              Resubmit is now a real form — a comment (optional, the maker may just
              be pushing back with no changes) plus attachments for the actual fix. */}
          {summary.can_resubmit && (
            <div style={{ marginTop: 4, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              {actionError && <div className="error-banner">{actionError}</div>}
              <div
                style={{
                  background: '#fffbeb',
                  border: '1px solid #fde68a',
                  borderRadius: 10,
                  padding: '14px 16px',
                  marginBottom: 12,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 800, color: '#b45309', marginBottom: 8 }}>{t.approvals.returnedBannerLabel}</div>
                <div style={{ fontSize: 15, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                  {[...summary.log].reverse().find((l) => l.action === 'returned')?.comments || t.approvals.returnedBannerFallback}
                </div>
                {(() => {
                  const returnedAttachments = [...summary.log].reverse().find((l) => l.action === 'returned')?.attachments;
                  return returnedAttachments && returnedAttachments.length > 0 ? <AttachmentGallery attachments={returnedAttachments} /> : null;
                })()}
              </div>

              {!resubmitting ? (
                <button className="btn btn-primary btn-sm" type="button" disabled={acting} onClick={() => setResubmitting(true)}>
                  {t.approvals.resubmit}
                </button>
              ) : (
                <div>
                  <div className="field">
                    <label>{t.approvals.resubmitCommentLabel}</label>
                    <textarea
                      rows={4}
                      value={resubmitComment}
                      onChange={(e) => setResubmitComment(e.target.value)}
                      placeholder={t.approvals.resubmitCommentPlaceholder}
                      style={{ fontSize: 14, lineHeight: 1.5, padding: 10 }}
                    />
                  </div>
                  <div className="field">
                    <label>{t.approvals.attachments}</label>
                    <label className="btn btn-secondary btn-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', width: 'fit-content' }}>
                      <IconPaperclip size={14} /> {t.approvals.addAttachment}
                      <input type="file" multiple style={{ display: 'none' }} onChange={(e) => addResubmitFiles(e.target.files)} />
                    </label>
                    {resubmitFiles.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                        {resubmitFiles.map((f, i) => (
                          <div key={`${f.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                            <button type="button" className="icon-btn" title={t.approvals.removeAttachment} onClick={() => removeResubmitFile(i)}>
                              <IconClose size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-primary btn-sm" type="button" disabled={acting} onClick={confirmResubmit}>
                      {acting ? t.common.loading : t.approvals.resubmit}
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      disabled={acting}
                      onClick={() => {
                        setResubmitting(false);
                        setResubmitComment('');
                        setResubmitFiles([]);
                        setActionError(null);
                      }}
                    >
                      {t.common.cancel}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
    {confirmingReject && (
      <ConfirmDialog
        title={t.approvals.reject}
        message={t.approvals.rejectConfirm}
        confirmLabel={t.approvals.reject}
        onConfirm={confirmReject}
        onCancel={() => setConfirmingReject(false)}
      />
    )}
    </Fragment>
  );
}
