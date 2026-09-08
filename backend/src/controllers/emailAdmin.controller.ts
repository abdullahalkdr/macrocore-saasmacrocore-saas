import { Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { isValidEmail } from '../utils/validate';
import { parsePagination } from '../utils/pagination';
import { enqueueEmail, requeueJobForRetry, testEmailHtml, EmailLang } from '../utils/email';

// POST /api/email-admin/test — sends one real test message through the actual
// Resend send path (or dev_skipped if RESEND_API_KEY isn't configured), using
// the real template shell, to an address the admin explicitly types in. Never
// a bare "hello world" — this is meant to answer "is delivery actually working,
// and does it look right in each language", the brief's Phase 1 requirement.
export const sendTestEmail = asyncHandler(async (req: Request, res: Response) => {
  const { to, lang } = req.body ?? {};
  if (!isValidEmail(to)) throw new AppError(400, 'A valid recipient email is required');
  const resolvedLang: EmailLang = lang === 'en' ? 'en' : 'ar';

  const { jobId } = await enqueueEmail({
    to: to.toLowerCase(),
    subject: resolvedLang === 'en' ? 'macrocore test email' : 'رسالة اختبار — macrocore',
    html: testEmailHtml(resolvedLang),
    category: 'test',
    lang: resolvedLang,
    // Every click is a deliberate, distinct test — no reason to dedupe one
    // against another the way a resend/forgot-password click would be.
    dedupKey: `test:${req.auth!.companyId}:${crypto.randomUUID()}`,
    companyId: req.auth!.companyId,
    relatedEntityType: 'users',
    relatedEntityId: req.auth!.userId,
  });

  res.status(200).json({ success: true, job_id: jobId });
});

// GET /api/email-admin/log — recent email_jobs for the caller's OWN company
// only (tenant isolation — WHERE company_id = $1, never trusts a query param
// for this). Deliberately excludes `html` (email body), `dedup_key` and
// `claimed_by` (internal machinery) — never returns anything from another
// tenant's rows or anything resembling a credential.
export const listEmailLog = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { limit, offset } = parsePagination(req, 25, 100);
  const category = typeof req.query.category === 'string' ? req.query.category : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';
  if (category) {
    params.push(category);
    where += ` AND category = $${params.length}`;
  }
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }

  const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM email_jobs WHERE ${where}`, params);
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT id, category, recipient_email, subject, status, attempt_count, max_attempts,
            last_error, related_entity_type, related_entity_id, created_at, sent_at, delivered_at, next_attempt_at
     FROM email_jobs
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.status(200).json({ success: true, jobs: result.rows, total: countResult.rows[0]?.count ?? 0 });
});

// POST /api/email-admin/:id/retry — re-enqueues the SAME job row (never a new
// one), so its history/id stays intact and the dedup_key uniqueness is
// untouched. Only eligible from a failed state, and only for a job that
// belongs to the caller's own company — a cross-tenant id is treated as not
// found, never leaked as "exists but forbidden".
export const retryEmailJob = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const jobResult = await pool.query<{ id: string; company_id: string | null; status: string }>(
    'SELECT id, company_id, status FROM email_jobs WHERE id = $1',
    [id]
  );
  const job = jobResult.rows[0];
  if (!job || job.company_id !== companyId) throw new AppError(404, 'Email job not found');
  if (job.status !== 'temp_failed' && job.status !== 'permanently_failed' && job.status !== 'requires_review') {
    throw new AppError(400, `This job isn't in a retryable state (status: ${job.status})`);
  }

  const requeued = await requeueJobForRetry(id);
  if (!requeued) throw new AppError(409, 'Job state changed before the retry could be applied — refresh and try again');

  res.status(200).json({ success: true });
});
