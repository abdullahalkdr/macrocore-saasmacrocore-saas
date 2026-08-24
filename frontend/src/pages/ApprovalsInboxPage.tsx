import { useEffect, useState } from 'react';
import { get, post, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';

// MIGRATION_055 — mirrors approval_requests + the requester_name/requester_job_role
// projection approvals.controller.ts's listPending() adds via its employees JOIN.
// MIGRATION_056 — current_step_label/_en are present only for multi-step rows
// (ITSM_TICKET today), naming which stage of the chain is currently pending.
interface ApprovalRequest {
  id: string;
  module_type: 'PAYROLL' | 'PURCHASE_ORDER' | 'EXPENSE' | 'ITSM_TICKET' | string;
  reference_id: string;
  requester_id: string;
  requester_name: string | null;
  requester_job_role: string | null;
  status: string;
  current_step: number;
  created_at: string;
  current_step_label?: string;
  current_step_label_en?: string | null;
}

export default function ApprovalsInboxPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  // Approve goes through a small comment modal (optional note for the audit trail);
  // Reject is a one-click quick action per the UX spec — no modal, just a native
  // confirm() the same way LeaveRequestsPage's own quick-status buttons work.
  const [approveTarget, setApproveTarget] = useState<ApprovalRequest | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function load() {
    get<{ requests: ApprovalRequest[] }>('/approvals/pending')
      .then((r) => setRequests(r.requests))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.approvals.loadFailed));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function moduleLabel(moduleType: string): string {
    return (t.approvals.moduleLabels as Record<string, string>)[moduleType] ?? moduleType;
  }

  function statusTag(status: string) {
    if (status === 'approved') return <Tag color="green">{t.approvals.statusApproved}</Tag>;
    if (status === 'rejected') return <Tag color="red">{t.approvals.statusRejected}</Tag>;
    if (status === 'cancelled') return <Tag color="gray">{t.approvals.statusCancelled}</Tag>;
    return <Tag color="amber">{t.approvals.statusPending}</Tag>;
  }

  async function submitApprove() {
    if (!approveTarget) return;
    setError(null);
    setSubmitting(true);
    try {
      await post(`/approvals/${approveTarget.id}/action`, { action: 'approved', comments: comment.trim() || undefined });
      setApproveTarget(null);
      setComment('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.approvals.actionFailed);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject(r: ApprovalRequest) {
    if (!confirm(t.approvals.rejectConfirm)) return;
    setError(null);
    setActingId(r.id);
    try {
      await post(`/approvals/${r.id}/action`, { action: 'rejected' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.approvals.actionFailed);
    } finally {
      setActingId(null);
    }
  }

  return (
    <div>
      <PageHeader title={t.approvals.title} subtitle={t.approvals.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="card-head">
          <h2>{t.approvals.listTitle}</h2>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.approvals.module}</th>
                <th>{t.approvals.requester}</th>
                <th>{t.approvals.requestedOn}</th>
                <th>{t.approvals.status}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 700 }}>
                    {moduleLabel(r.module_type)}
                    {r.current_step_label && (
                      <div className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                        {lang === 'ar' ? r.current_step_label : r.current_step_label_en || r.current_step_label}
                      </div>
                    )}
                  </td>
                  <td>
                    {r.requester_name || '—'}
                    {r.requester_job_role && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {r.requester_job_role}
                      </div>
                    )}
                  </td>
                  <td>{r.created_at.slice(0, 10)}</td>
                  <td>{statusTag(r.status)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={actingId === r.id}
                        onClick={() => {
                          setApproveTarget(r);
                          setComment('');
                        }}
                      >
                        {t.approvals.approve}
                      </button>
                      <button className="btn btn-danger btn-sm" disabled={actingId === r.id} onClick={() => handleReject(r)}>
                        {t.approvals.reject}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {requests.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.approvals.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {approveTarget && (
        <Modal
          title={t.approvals.commentModalTitle}
          onClose={() => setApproveTarget(null)}
          actions={
            <>
              <button className="btn btn-primary" type="button" disabled={submitting} onClick={submitApprove}>
                {submitting ? t.common.loading : t.approvals.confirmApprove}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setApproveTarget(null)}>
                {t.common.cancel}
              </button>
            </>
          }
        >
          <div className="field">
            <label>{t.approvals.commentLabel}</label>
            <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t.approvals.commentPlaceholder} />
          </div>
        </Modal>
      )}
    </div>
  );
}
