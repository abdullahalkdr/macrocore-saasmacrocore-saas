import { FormEvent, useState, useCallback, useEffect } from 'react';
import { get, post, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import { needsExplicitReviewConfirmation } from './emailRetryUx';

type EmailJobStatus =
  | 'queued'
  | 'processing'
  | 'sent'
  | 'delivered'
  | 'delayed'
  | 'temp_failed'
  | 'permanently_failed'
  | 'bounced'
  | 'complained'
  | 'suppressed'
  | 'cancelled'
  | 'dev_skipped'
  | 'requires_review';

interface EmailJob {
  id: string;
  category: string;
  recipient_email: string;
  status: EmailJobStatus;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  next_attempt_at: string;
}

// Groups every status into one of four visual buckets — the same emerald/amber/
// red/stone semantic split the rest of the app's .badge classes already use
// (see frontend/src/styles.css), rather than inventing an eleven-way palette.
const STATUS_BADGE_CLASS: Record<EmailJobStatus, string> = {
  sent: 'email-ok',
  delivered: 'email-ok',
  queued: 'email-neutral',
  processing: 'email-neutral',
  dev_skipped: 'email-neutral',
  delayed: 'email-warn',
  temp_failed: 'email-warn',
  permanently_failed: 'email-bad',
  bounced: 'email-bad',
  complained: 'email-bad',
  suppressed: 'email-neutral',
  cancelled: 'email-neutral',
  requires_review: 'email-bad',
};

const RETRYABLE_STATUSES: EmailJobStatus[] = ['temp_failed', 'permanently_failed', 'requires_review'];

export default function EmailDeliverySection() {
  const t = useT();
  const labels = t.account.emailDelivery.statusLabels;

  const [to, setTo] = useState('');
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);

  const [jobs, setJobs] = useState<EmailJob[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  // A requires_review row shows a distinct bilingual warning + explicit
  // confirm step instead of the ordinary one-click retry -- Resend's
  // Idempotency-Key window may already have elapsed for a job reclaimed
  // after an apparent backend crash, so a blind retry isn't always safe.
  // Tracks at most one row's confirm state open at a time.
  const [confirmingReviewId, setConfirmingReviewId] = useState<string | null>(null);

  const load = useCallback((nextPage: number, append: boolean) => {
    get<{ jobs: EmailJob[]; total: number }>(`/email-admin/log?page=${nextPage}&limit=25`)
      .then((r) => {
        setJobs((prev) => (append ? [...prev, ...r.jobs] : r.jobs));
        setTotal(r.total);
        setPage(nextPage);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : t.account.loadFailed));
  }, [t.account.loadFailed]);

  useEffect(() => {
    load(1, false);
  }, [load]);

  async function handleSendTest(e: FormEvent) {
    e.preventDefault();
    setSendError(null);
    setSendSuccess(null);
    setSending(true);
    try {
      await post('/email-admin/test', { to, lang });
      setSendSuccess(t.account.emailDelivery.testSent);
      setTo('');
      load(1, false);
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : t.account.saveFailed);
    } finally {
      setSending(false);
    }
  }

  async function handleRetry(jobId: string) {
    setRetryingId(jobId);
    try {
      await post(`/email-admin/${jobId}/retry`, {});
      load(1, false);
    } catch {
      setLoadError(t.account.emailDelivery.retryFailed);
    } finally {
      setRetryingId(null);
      setConfirmingReviewId((current) => (current === jobId ? null : current));
    }
  }

  return (
    <div>
      <div className="card">
        <div className="card-head">
          <h2>{t.account.sections.emailDeliveryTitle}</h2>
        </div>
        <div className="card-body">
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            {t.account.emailDelivery.testHint}
          </p>
          {sendError && <div className="error-banner">{sendError}</div>}
          {sendSuccess && <div className="success-banner">{sendSuccess}</div>}
          <form onSubmit={handleSendTest} className="form-row">
            <div className="field" style={{ flex: 2 }}>
              <input
                type="email"
                required
                placeholder={t.account.emailDelivery.recipientPlaceholder}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="field">
              <label>{t.account.emailDelivery.language}</label>
              <select value={lang} onChange={(e) => setLang(e.target.value as 'ar' | 'en')}>
                <option value="ar">{t.account.emailDelivery.languageArabic}</option>
                <option value="en">{t.account.emailDelivery.languageEnglish}</option>
              </select>
            </div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={sending}>
              {sending ? t.account.emailDelivery.sending : t.account.emailDelivery.send}
            </button>
          </form>
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>{t.account.emailDelivery.logTitle}</h2>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => load(1, false)}>
            {t.account.emailDelivery.refresh}
          </button>
        </div>
        <div className="card-body">
          {loadError && <div className="error-banner">{loadError}</div>}
          {jobs.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>{t.account.emailDelivery.empty}</p>
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.account.emailDelivery.colCategory}</th>
                    <th>{t.account.emailDelivery.colRecipient}</th>
                    <th>{t.account.emailDelivery.colStatus}</th>
                    <th>{t.account.emailDelivery.colAttempts}</th>
                    <th>{t.account.emailDelivery.colLastError}</th>
                    <th>{t.account.emailDelivery.colCreated}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id}>
                      <td>{job.category}</td>
                      <td>{job.recipient_email}</td>
                      <td>
                        <span className={`badge ${STATUS_BADGE_CLASS[job.status]}`}>{labels[job.status] ?? job.status}</span>
                      </td>
                      <td>{job.attempt_count}/{job.max_attempts}</td>
                      <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--muted)' }} title={job.last_error ?? ''}>
                        {job.last_error ?? ''}
                      </td>
                      <td>{new Date(job.created_at).toLocaleString()}</td>
                      <td>
                        {RETRYABLE_STATUSES.includes(job.status) &&
                          (needsExplicitReviewConfirmation(job.status) ? (
                            confirmingReviewId === job.id ? (
                              <div className="email-review-confirm" style={{ minWidth: 200 }}>
                                <p className="muted" style={{ fontSize: 11, margin: '0 0 6px' }}>
                                  {t.account.emailDelivery.requiresReviewNotice}
                                </p>
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <button
                                    className="btn btn-danger btn-sm"
                                    type="button"
                                    disabled={retryingId === job.id}
                                    onClick={() => handleRetry(job.id)}
                                  >
                                    {retryingId === job.id ? t.account.emailDelivery.retrying : t.account.emailDelivery.confirmRetryAnyway}
                                  </button>
                                  <button
                                    className="btn btn-secondary btn-sm"
                                    type="button"
                                    onClick={() => setConfirmingReviewId(null)}
                                  >
                                    {t.account.emailDelivery.cancel}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setConfirmingReviewId(job.id)}>
                                {t.account.emailDelivery.retry}
                              </button>
                            )
                          ) : (
                            <button
                              className="btn btn-secondary btn-sm"
                              type="button"
                              disabled={retryingId === job.id}
                              onClick={() => handleRetry(job.id)}
                            >
                              {retryingId === job.id ? t.account.emailDelivery.retrying : t.account.emailDelivery.retry}
                            </button>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {jobs.length < total && (
                <div style={{ marginTop: 12, textAlign: 'center' }}>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => load(page + 1, true)}>
                    {t.account.emailDelivery.loadMore}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
