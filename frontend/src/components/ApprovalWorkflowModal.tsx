import { useEffect, useState } from 'react';
import { get, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import Modal from './Modal';
import Tag from './Tag';

// Shared "Approval status" popup — opened by clicking any approval status tag in
// ExpensesPage/PayrollPage/PurchaseOrdersPage/ApprovalsInboxPage. Read-only: shows the
// request's own details (passed in by the caller, who already has the row loaded) plus
// a vertical timeline of the approval workflow (submitted -> each step -> outcome),
// fetched from the one shared GET /api/approvals/summary endpoint that generalizes
// across single-step financial modules and ITSM_TICKET's real multi-step chain.
//
// Built as a vertical timeline rather than a horizontal "from -> to -> to" row of
// chips on purpose: a horizontal arrow's direction reads backwards once the page
// flips to RTL Arabic, while a top-to-bottom timeline (dot + connecting line, like a
// shipment tracker) reads identically in both languages and still shows the exact
// same "where is it now / what's next" information.
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
interface ApprovalSummary {
  id: string;
  module_type: string;
  status: string;
  current_step: number;
  total_steps: number;
  requester_name: string | null;
  requester_job_role: string | null;
  steps: ApprovalStepDef[];
  log: ApprovalLogEntry[];
  is_pending_approver: boolean;
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
}

const DOT_COLOR: Record<NodeState, string> = {
  done: '#22c55e',
  current: '#f5a623',
  upcoming: '#d6d3d1',
  rejected: '#dc2626',
};

export default function ApprovalWorkflowModal({ moduleType, referenceId, detailLines, onClose }: Props) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const [summary, setSummary] = useState<ApprovalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    get<{ summary: ApprovalSummary | null }>(
      `/approvals/summary?module_type=${encodeURIComponent(moduleType)}&reference_id=${encodeURIComponent(referenceId)}`
    )
      .then((r) => setSummary(r.summary))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.approvalWorkflow.loadFailed))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleType, referenceId]);

  function stepLabel(s: ApprovalStepDef) {
    return lang === 'ar' ? s.step_label : s.step_label_en || s.step_label;
  }

  function outcomeTag(status: string) {
    if (status === 'approved') return <Tag color="green">{t.approvals.statusApproved}</Tag>;
    if (status === 'rejected') return <Tag color="red">{t.approvals.statusRejected}</Tag>;
    if (status === 'cancelled') return <Tag color="gray">{t.approvals.statusCancelled}</Tag>;
    return <Tag color="amber">{t.approvals.statusPending}</Tag>;
  }

  const moduleLabel = (t.approvals.moduleLabels as Record<string, string>)[moduleType] ?? moduleType;

  const timelineNodes: { key: string; label: string; state: NodeState; meta?: string }[] = [];
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
      timelineNodes.push({ key: `step-${s.step_number}`, label: stepLabel(s), state, meta });
    });

    timelineNodes.push({
      key: 'outcome',
      label:
        summary.status === 'approved'
          ? t.approvals.statusApproved
          : summary.status === 'rejected'
            ? t.approvals.statusRejected
            : t.approvalWorkflow.finalDecisionLabel,
      state: summary.status === 'approved' ? 'done' : summary.status === 'rejected' ? 'rejected' : 'upcoming',
    });
  }

  return (
    <Modal
      title={`${t.approvalWorkflow.title} — ${moduleLabel}`}
      onClose={onClose}
      actions={
        <button className="btn btn-secondary" type="button" onClick={onClose}>
          {t.common.close}
        </button>
      }
    >
      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="muted">{t.common.loading}</div>}

      {!loading && detailLines.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)', marginBottom: 8 }}>{t.approvalWorkflow.detailsTitle}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', marginBottom: 18, fontSize: 13 }}>
            {detailLines.map((d) => (
              <div key={d.label} style={{ display: 'contents' }}>
                <span className="muted">{d.label}</span>
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
                  {node.state === 'current' && (
                    <div style={{ fontSize: 11, color: '#b45309', marginTop: 2, fontWeight: 700 }}>{t.approvalWorkflow.waitingOnLabel}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
