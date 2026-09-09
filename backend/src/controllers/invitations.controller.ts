import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { isValidEmail } from '../utils/validate';
import { logAudit } from '../utils/audit';
import {
  ALL_ROLES,
  InvitableRole,
  assertInvitableRole,
  createOrRefreshInvitation,
  deriveInvitationStatus,
  normalizeInviteEmail,
  resendInvitationById,
  revokeInvitationById,
} from '../utils/invitations';
import { EmailLang } from '../utils/email';

async function loadInviterContext(userId: string): Promise<{ companyName: string; inviterName: string | null }> {
  const result = await pool.query<{ company_name: string; inviter_name: string | null }>(
    `SELECT c.name AS company_name, u.full_name AS inviter_name
     FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.id = $1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, 'User not found');
  return { companyName: row.company_name, inviterName: row.inviter_name };
}

// Pending-invitations list (decision 8) — admin/manager only, scoped to the
// caller's own company. Status is derived, never stored — see
// utils/invitations.ts's deriveInvitationStatus().
export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT i.id, i.email, i.role, i.full_name, i.accepted_at, i.revoked_at, i.expires_at,
            i.created_at, i.updated_at, u.full_name AS invited_by_name
     FROM employee_invitations i
     LEFT JOIN users u ON u.id = i.invited_by
     WHERE i.company_id = $1
     ORDER BY i.created_at DESC`,
    [companyId]
  );
  const invitations = result.rows.map((row) => ({ ...row, status: deriveInvitationStatus(row) }));
  res.status(200).json({ success: true, invitations });
});

// Single entry point for both UI surfaces (Users page "+ New", and
// register()'s colleague-invite loop calls createOrRefreshInvitation
// directly — see auth.controller.ts). Body language follows the same
// convention as POST /auth/register: the frontend's current UI language,
// not a stored per-user default.
export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const inviterRole = req.auth!.role;
  const { email, role, full_name, preferred_language } = req.body ?? {};

  if (!isValidEmail(email)) throw new AppError(400, 'Invalid email format');
  if (typeof role !== 'string' || !ALL_ROLES.includes(role as InvitableRole)) {
    throw new AppError(400, `role must be one of ${ALL_ROLES.join(', ')}`);
  }
  assertInvitableRole(inviterRole, role);

  const fullName = typeof full_name === 'string' && full_name.trim() ? full_name.trim() : null;
  const lang: EmailLang = preferred_language === 'en' ? 'en' : 'ar';

  const { companyName, inviterName } = await loadInviterContext(req.auth!.userId);

  const outcome = await createOrRefreshInvitation({
    companyId,
    companyName,
    email: normalizeInviteEmail(email),
    role: role as InvitableRole,
    fullName,
    invitedBy: req.auth!.userId,
    inviterName,
    preferredLanguage: lang,
  });

  if (outcome.status === 'skipped') {
    const message =
      outcome.reason === 'already_member'
        ? 'This person is already part of your team'
        // Decision 11: generic, non-enumerating — never reveals whether the
        // conflict is an existing account or a pending invitation elsewhere.
        : 'This email can’t be invited right now — it may already have an account or a pending invitation elsewhere';
    throw new AppError(409, message);
  }

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'invitation_sent',
    entityType: 'employee_invitations',
    entityId: outcome.invitation.id,
    req,
  });

  // Never claim "Invitation sent" when the email job wasn't actually queued
  // (review requirement) — the invitation row/link itself is real either
  // way, email_queued tells the frontend whether to also surface a
  // "use Resend to try again" notice.
  const emailQueued = outcome.status === 'sent';
  res.status(201).json({
    success: true,
    invitation: { ...outcome.invitation, status: deriveInvitationStatus(outcome.invitation) },
    email_queued: emailQueued,
    message: emailQueued ? 'Invitation sent' : 'Invitation created, but the email failed to send — use Resend to try again',
  });
});

export const resend = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const existing = await pool.query('SELECT role FROM employee_invitations WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Invitation not found');
  assertInvitableRole(req.auth!.role, existing.rows[0].role);

  const { companyName, inviterName } = await loadInviterContext(req.auth!.userId);
  const { invitation, queued } = await resendInvitationById(id, companyId, companyName, inviterName);

  await logAudit({ companyId, userId: req.auth!.userId, action: 'invitation_resent', entityType: 'employee_invitations', entityId: id, req });

  res.status(200).json({
    success: true,
    invitation: { ...invitation, status: deriveInvitationStatus(invitation) },
    email_queued: queued,
    message: queued ? 'Invitation resent' : 'Invitation updated, but the email failed to send — try Resend again',
  });
});

export const revoke = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const existing = await pool.query('SELECT role FROM employee_invitations WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Invitation not found');
  assertInvitableRole(req.auth!.role, existing.rows[0].role);

  const invitation = await revokeInvitationById(id, companyId, req.auth!.userId);

  await logAudit({ companyId, userId: req.auth!.userId, action: 'invitation_revoked', entityType: 'employee_invitations', entityId: id, req });

  res.status(200).json({ success: true, invitation: { ...invitation, status: deriveInvitationStatus(invitation) }, message: 'Invitation revoked' });
});
