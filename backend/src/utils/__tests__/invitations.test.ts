import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// No real Postgres is available to this test suite (backend/vitest.config.ts
// points DATABASE_URL at a fake address) — same constraint email.test.ts
// documents. So the DB pool is mocked entirely: mockClient.query is a single
// regex-dispatched handler per test, matched against the actual SQL text
// invitations.ts sends, which is what lets these tests assert the real
// locking/guard behavior (FOR UPDATE, the advisory lock, guarded UPDATEs)
// without a live database.
// ---------------------------------------------------------------------------
// Typed loosely (any) on purpose: pg's real Pool/PoolClient `query` method is
// a wide overloaded signature, and pinning these mocks to it would fight the
// type checker for no benefit in a test file — what matters here is the SQL
// text and rows each call is wired to return, not statically matching pg's
// own overloads.
//
// Declared via vi.hoisted() because vi.mock(...) calls below are themselves
// hoisted above all imports/consts by Vitest's transform — referencing a
// plain `const` from inside a vi.mock factory would hit it before
// initialization (TDZ) at runtime. vi.hoisted() runs its initializer in that
// same hoisted position, so these are ready by the time the factories run.
const { mockClient, mockPool, mockEnqueueEmail } = vi.hoisted(() => {
  const mockClient: { query: any; release: any } = { query: vi.fn(), release: vi.fn() };
  const mockPool: { connect: any; query: any } = { connect: vi.fn(async () => mockClient), query: vi.fn() };
  const mockEnqueueEmail = vi.fn();
  return { mockClient, mockPool, mockEnqueueEmail };
});

vi.mock('../../db/pool', () => ({ pool: mockPool }));
vi.mock('../email', async () => {
  const actual = await vi.importActual<typeof import('../email')>('../email');
  return { ...actual, enqueueEmail: (...args: unknown[]) => mockEnqueueEmail(...args) };
});

import {
  acquireEmailLock,
  createOrRefreshInvitation,
  resendInvitationById,
  revokeInvitationById,
  lockInvitationByRawTokenForUpdate,
  deriveInvitationStatus,
  sendInvitationEmail,
  type InvitationRow,
} from '../invitations';
import { AppError } from '../../middleware/errorHandler';

// A minimal, always-valid invitation row builder — tests override only the
// fields relevant to that scenario.
function row(overrides: Partial<InvitationRow> = {}): InvitationRow {
  const now = new Date();
  return {
    id: 'inv-1',
    company_id: 'company-a',
    email: 'invitee@example.com',
    role: 'employee',
    full_name: null,
    invited_by: 'user-1',
    token_hash: 'hash',
    expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    accepted_at: null,
    accepted_user_id: null,
    revoked_at: null,
    revoked_by: null,
    preferred_language: 'ar',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

// Dispatches mockClient.query calls by matching the SQL text against a list
// of {match, result} handlers, in order. BEGIN/COMMIT/ROLLBACK are handled
// automatically. Throws loudly on an unrecognized query so a test can't pass
// by silently returning `undefined` for a call it forgot to stub.
function wireClient(handlers: { match: RegExp; result: unknown }[]) {
  mockClient.query.mockImplementation(async (sql: string) => {
    // BEGIN/COMMIT/ROLLBACK and the per-email advisory lock are plumbing
    // every mutating path issues — auto-handled so each test only wires the
    // query(ies) it actually cares about. The advisory-lock call still shows
    // up in mock.calls (this still runs through the mock fn), so tests that
    // assert lock ORDERING (see "serializes on the normalized email...")
    // still work.
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim()) || /pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 };
    for (const h of handlers) {
      if (h.match.test(sql)) return typeof h.result === 'function' ? (h.result as () => unknown)() : h.result;
    }
    throw new Error(`invitations.test.ts: no handler wired for query: ${sql}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.connect.mockImplementation(async () => mockClient);
  mockEnqueueEmail.mockResolvedValue({ jobId: 'job-1', deduped: false });
});

// ---------------------------------------------------------------------------
// deriveInvitationStatus — the precedence single-use/expiry/revoke checks in
// acceptInvitation() (and the resend/revoke guards) all depend on.
// ---------------------------------------------------------------------------
describe('deriveInvitationStatus', () => {
  it('accepted takes precedence over everything else', () => {
    expect(deriveInvitationStatus({ accepted_at: new Date().toISOString(), revoked_at: new Date().toISOString(), expires_at: new Date(0).toISOString() })).toBe(
      'accepted'
    );
  });

  it('revoked takes precedence over expiry when not accepted', () => {
    expect(deriveInvitationStatus({ accepted_at: null, revoked_at: new Date().toISOString(), expires_at: new Date(0).toISOString() })).toBe('revoked');
  });

  it('an expired, unrevoked, unaccepted row is expired', () => {
    expect(deriveInvitationStatus({ accepted_at: null, revoked_at: null, expires_at: new Date(0).toISOString() })).toBe('expired');
  });

  it('otherwise pending', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(deriveInvitationStatus({ accepted_at: null, revoked_at: null, expires_at: future })).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// sendInvitationEmail — invitation language + "never say sent when not
// queued" at the unit closest to enqueueEmail().
// ---------------------------------------------------------------------------
describe('sendInvitationEmail', () => {
  it('renders the invitation link email in the invitation’s own preferred_language, not a hardcoded default', async () => {
    await sendInvitationEmail(row({ preferred_language: 'en' }), 'Acme', 'rawtoken123', 'Inviter Name');
    expect(mockEnqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ lang: 'en' }));

    mockEnqueueEmail.mockClear();
    await sendInvitationEmail(row({ preferred_language: 'ar' }), 'Acme', 'rawtoken123', 'Inviter Name');
    expect(mockEnqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ lang: 'ar' }));
  });

  it('reports queued: true when enqueueEmail actually persisted a job', async () => {
    mockEnqueueEmail.mockResolvedValue({ jobId: 'job-123', deduped: false });
    const result = await sendInvitationEmail(row(), 'Acme', 'rawtoken123', null);
    expect(result).toEqual({ queued: true });
  });

  it('reports queued: false — never true — when enqueueEmail could not queue the job (jobId null)', async () => {
    mockEnqueueEmail.mockResolvedValue({ jobId: null, deduped: false });
    const result = await sendInvitationEmail(row(), 'Acme', 'rawtoken123', null);
    expect(result).toEqual({ queued: false });
  });
});

// ---------------------------------------------------------------------------
// createOrRefreshInvitation — cross-company conflicts (across multiple
// historical rows) + never reporting "sent" when the email failed to queue.
// ---------------------------------------------------------------------------
describe('createOrRefreshInvitation', () => {
  const baseInput = {
    companyId: 'company-a',
    companyName: 'Company A',
    email: 'invitee@example.com',
    role: 'employee' as const,
    fullName: null,
    invitedBy: 'user-1',
    inviterName: 'Inviter',
    preferredLanguage: 'ar' as const,
  };

  it('skips as already_member when the same-company row is already accepted', async () => {
    wireClient([
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      {
        match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/,
        result: { rows: [row({ company_id: 'company-a', accepted_at: new Date().toISOString() })] },
      },
    ]);
    const outcome = await createOrRefreshInvitation(baseInput);
    expect(outcome).toEqual({ status: 'skipped', reason: 'already_member' });
    expect(mockEnqueueEmail).not.toHaveBeenCalled();
  });

  it('detects a cross-company conflict even when it is buried among several historical rows for the same email (regression: the old code only looked at rows[0])', async () => {
    wireClient([
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      {
        match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/,
        result: {
          rows: [
            // Old, resolved history in unrelated companies — must NOT block.
            row({ id: 'old-1', company_id: 'company-x', revoked_at: new Date().toISOString() }),
            row({ id: 'old-2', company_id: 'company-y', accepted_at: new Date().toISOString() }),
            row({ id: 'old-3', company_id: 'company-z', expires_at: new Date(0).toISOString() }),
            // The real conflict: a currently-pending row in yet another
            // company, listed last on purpose so a "just check rows[0]" bug
            // would miss it.
            row({ id: 'live-conflict', company_id: 'company-w', expires_at: new Date(Date.now() + 60_000).toISOString() }),
          ],
        },
      },
    ]);
    const outcome = await createOrRefreshInvitation(baseInput);
    expect(outcome).toEqual({ status: 'skipped', reason: 'conflict_elsewhere' });
    expect(mockEnqueueEmail).not.toHaveBeenCalled();
  });

  it('rejects a genuine cross-company conflict even when a resolved (revoked/expired) row also exists in the SAME company (regression: the old `!sameCompanyRow && crossCompanyConflict` condition let this fall through to the refresh branch instead of blocking — production-review fix #1, 2026-09-09)', async () => {
    wireClient([
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      {
        match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/,
        result: {
          rows: [
            // Resolved (revoked) row in THIS company — must not, by itself,
            // let the request through.
            row({ id: 'inv-1', company_id: 'company-a', revoked_at: new Date().toISOString() }),
            // The real conflict: a currently-pending row in another company.
            row({ id: 'other', company_id: 'company-w', expires_at: new Date(Date.now() + 60_000).toISOString() }),
          ],
        },
      },
    ]);
    const outcome = await createOrRefreshInvitation(baseInput);
    expect(outcome).toEqual({ status: 'skipped', reason: 'conflict_elsewhere' });
    expect(mockEnqueueEmail).not.toHaveBeenCalled();
    const calls: string[] = mockClient.query.mock.calls.map((c: any[]) => String(c[0]));
    // Must neither refresh the resolved same-company row nor insert a new one.
    expect(calls.some((sql: string) => /^UPDATE employee_invitations\s+SET role/.test(sql.trim()))).toBe(false);
    expect(calls.some((sql: string) => /^INSERT INTO employee_invitations/.test(sql.trim()))).toBe(false);
  });

  it('creates a new invitation and reports sent when the email is actually queued', async () => {
    const inserted = row();
    wireClient([
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      { match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/, result: { rows: [] } },
      { match: /INSERT INTO employee_invitations/, result: { rows: [inserted] } },
    ]);
    mockEnqueueEmail.mockResolvedValue({ jobId: 'job-1', deduped: false });

    const outcome = await createOrRefreshInvitation(baseInput);
    expect(outcome.status).toBe('sent');
  });

  it('never reports "sent" when the email failed to queue — reports sent_email_failed instead, with the invitation still created', async () => {
    const inserted = row();
    wireClient([
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      { match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/, result: { rows: [] } },
      { match: /INSERT INTO employee_invitations/, result: { rows: [inserted] } },
    ]);
    mockEnqueueEmail.mockResolvedValue({ jobId: null, deduped: false });

    const outcome = await createOrRefreshInvitation(baseInput);
    expect(outcome.status).toBe('sent_email_failed');
    if (outcome.status === 'sent_email_failed') {
      expect(outcome.invitation.id).toBe(inserted.id);
    }
  });

  it('refreshes an existing same-company row IN PLACE (single-use link invalidation: only one token_hash ever exists per company+email) instead of inserting a duplicate — decision 6', async () => {
    const existing = row({ id: 'inv-1', company_id: 'company-a', token_hash: 'old-hash', revoked_at: new Date().toISOString() });
    const refreshed = row({ id: 'inv-1', company_id: 'company-a', token_hash: 'new-hash', revoked_at: null });
    wireClient([
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      { match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/, result: { rows: [existing] } },
      { match: /UPDATE employee_invitations\s+SET role/, result: { rows: [refreshed] } },
    ]);
    mockEnqueueEmail.mockResolvedValue({ jobId: 'job-1', deduped: false });

    const outcome = await createOrRefreshInvitation(baseInput);
    expect(outcome.status).toBe('sent');
    if (outcome.status === 'sent') {
      expect(outcome.invitation.id).toBe('inv-1'); // same row, not a new one
      expect(outcome.invitation.token_hash).toBe('new-hash');
      expect(outcome.invitation.revoked_at).toBeNull(); // reset on refresh
    }
    const calls: string[] = mockClient.query.mock.calls.map((c: any[]) => String(c[0]));
    expect(calls.some((sql: string) => /^INSERT INTO employee_invitations/.test(sql.trim()))).toBe(false);
  });

  it('serializes on the normalized email via an advisory lock before doing any conflict scan', async () => {
    wireClient([
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      { match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/, result: { rows: [] } },
      { match: /INSERT INTO employee_invitations/, result: { rows: [row()] } },
    ]);
    await createOrRefreshInvitation(baseInput);
    const calls: string[] = mockClient.query.mock.calls.map((c: any[]) => String(c[0]));
    const lockIndex = calls.findIndex((sql: string) => /pg_advisory_xact_lock/.test(sql));
    const scanIndex = calls.findIndex((sql: string) => /FROM employee_invitations WHERE email = \$1 FOR UPDATE/.test(sql));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(scanIndex).toBeGreaterThan(lockIndex);
  });
});

// ---------------------------------------------------------------------------
// resendInvitationById — old-token invalidation, cross-company conflicts on
// reactivation, and the guarded UPDATE losing a race.
// ---------------------------------------------------------------------------
describe('resendInvitationById', () => {
  it('404s when the invitation does not exist for this company', async () => {
    wireClient([{ match: /SELECT email FROM employee_invitations WHERE id = \$1 AND company_id = \$2/, result: { rows: [] } }]);
    await expect(resendInvitationById('missing', 'company-a', 'Company A', null)).rejects.toMatchObject({ statusCode: 404 } as Partial<AppError>);
  });

  it('refuses to resend an already-accepted invitation (409)', async () => {
    wireClient([
      { match: /SELECT email FROM employee_invitations WHERE id = \$1 AND company_id = \$2/, result: { rows: [{ email: 'invitee@example.com' }] } },
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      {
        match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/,
        result: { rows: [row({ id: 'inv-1', company_id: 'company-a', accepted_at: new Date().toISOString() })] },
      },
    ]);
    await expect(resendInvitationById('inv-1', 'company-a', 'Company A', null)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses to resend when another company now holds a genuinely pending invitation for this email', async () => {
    wireClient([
      { match: /SELECT email FROM employee_invitations WHERE id = \$1 AND company_id = \$2/, result: { rows: [{ email: 'invitee@example.com' }] } },
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      {
        match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/,
        result: {
          rows: [
            row({ id: 'inv-1', company_id: 'company-a', revoked_at: new Date().toISOString() }),
            row({ id: 'other', company_id: 'company-b', expires_at: new Date(Date.now() + 60_000).toISOString() }),
          ],
        },
      },
    ]);
    await expect(resendInvitationById('inv-1', 'company-a', 'Company A', null)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('regenerates the token on a successful resend — old-token invalidation follows from this being the only token_hash the row ever has', async () => {
    const before = row({ id: 'inv-1', company_id: 'company-a', token_hash: 'old-hash' });
    const after = row({ id: 'inv-1', company_id: 'company-a', token_hash: 'new-hash' });
    wireClient([
      { match: /SELECT email FROM employee_invitations WHERE id = \$1 AND company_id = \$2/, result: { rows: [{ email: 'invitee@example.com' }] } },
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      { match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/, result: { rows: [before] } },
      { match: /UPDATE employee_invitations\s+SET token_hash/, result: { rows: [after] } },
    ]);
    mockEnqueueEmail.mockResolvedValue({ jobId: 'job-1', deduped: false });

    const { invitation, queued } = await resendInvitationById('inv-1', 'company-a', 'Company A', null);
    expect(invitation.token_hash).toBe('new-hash');
    expect(invitation.token_hash).not.toBe(before.token_hash);
    expect(queued).toBe(true);
  });

  it('refuses to resend when a users account now exists for this email (e.g. a concurrent accept won first) — never regenerates or emails a new link (production-review fix #3, 2026-09-09)', async () => {
    wireClient([
      { match: /SELECT email FROM employee_invitations WHERE id = \$1 AND company_id = \$2/, result: { rows: [{ email: 'invitee@example.com' }] } },
      { match: /FROM users WHERE email = \$1/, result: { rows: [{ id: 'user-1' }] } },
      // Deliberately no handler for the invitation-rows scan or the token
      // UPDATE — if the code regresses to reaching either of those before
      // this check rejects, wireClient throws loudly instead of the test
      // silently passing.
    ]);
    await expect(resendInvitationById('inv-1', 'company-a', 'Company A', null)).rejects.toMatchObject({ statusCode: 409 });
    expect(mockEnqueueEmail).not.toHaveBeenCalled();
  });

  it('checks for an existing users account before scanning/locking invitation rows on resend', async () => {
    wireClient([
      { match: /SELECT email FROM employee_invitations WHERE id = \$1 AND company_id = \$2/, result: { rows: [{ email: 'invitee@example.com' }] } },
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      { match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/, result: { rows: [row({ id: 'inv-1', company_id: 'company-a' })] } },
      { match: /UPDATE employee_invitations\s+SET token_hash/, result: { rows: [row({ id: 'inv-1', company_id: 'company-a' })] } },
    ]);
    await resendInvitationById('inv-1', 'company-a', 'Company A', null);
    const calls: string[] = mockClient.query.mock.calls.map((c: any[]) => String(c[0]));
    const userCheckIdx = calls.findIndex((sql: string) => /FROM users WHERE email = \$1/.test(sql));
    const scanIdx = calls.findIndex((sql: string) => /FROM employee_invitations WHERE email = \$1 FOR UPDATE/.test(sql));
    expect(userCheckIdx).toBeGreaterThanOrEqual(0);
    expect(scanIdx).toBeGreaterThan(userCheckIdx);
  });

  it('surfaces queued: false (never claims success) when the resend email fails to queue', async () => {
    wireClient([
      { match: /SELECT email FROM employee_invitations WHERE id = \$1 AND company_id = \$2/, result: { rows: [{ email: 'invitee@example.com' }] } },
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      { match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/, result: { rows: [row({ id: 'inv-1', company_id: 'company-a' })] } },
      { match: /UPDATE employee_invitations\s+SET token_hash/, result: { rows: [row({ id: 'inv-1', company_id: 'company-a' })] } },
    ]);
    mockEnqueueEmail.mockResolvedValue({ jobId: null, deduped: false });

    const { queued } = await resendInvitationById('inv-1', 'company-a', 'Company A', null);
    expect(queued).toBe(false);
  });

  it('fails loudly (409) rather than silently succeeding when the guarded UPDATE loses a race (rowCount 0 — e.g. a concurrent accept won first)', async () => {
    wireClient([
      { match: /SELECT email FROM employee_invitations WHERE id = \$1 AND company_id = \$2/, result: { rows: [{ email: 'invitee@example.com' }] } },
      { match: /FROM users WHERE email = \$1/, result: { rows: [] } },
      { match: /FROM employee_invitations WHERE email = \$1 FOR UPDATE/, result: { rows: [row({ id: 'inv-1', company_id: 'company-a' })] } },
      { match: /UPDATE employee_invitations\s+SET token_hash/, result: { rows: [] } }, // lost the race
    ]);
    await expect(resendInvitationById('inv-1', 'company-a', 'Company A', null)).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ---------------------------------------------------------------------------
// revokeInvitationById
// ---------------------------------------------------------------------------
describe('revokeInvitationById', () => {
  it('404s on an unknown invitation', async () => {
    wireClient([{ match: /SELECT \* FROM employee_invitations WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, result: { rows: [] } }]);
    await expect(revokeInvitationById('missing', 'company-a', 'user-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses to revoke an already-accepted invitation', async () => {
    wireClient([
      {
        match: /SELECT \* FROM employee_invitations WHERE id = \$1 AND company_id = \$2 FOR UPDATE/,
        result: { rows: [row({ accepted_at: new Date().toISOString() })] },
      },
    ]);
    await expect(revokeInvitationById('inv-1', 'company-a', 'user-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('revokes a pending invitation successfully', async () => {
    wireClient([
      { match: /SELECT \* FROM employee_invitations WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, result: { rows: [row()] } },
      { match: /UPDATE employee_invitations SET revoked_at/, result: { rows: [row({ revoked_at: new Date().toISOString(), revoked_by: 'user-1' })] } },
    ]);
    const updated = await revokeInvitationById('inv-1', 'company-a', 'user-1');
    expect(updated.revoked_at).not.toBeNull();
  });

  it('fails loudly (409) when the guarded revoke UPDATE loses a race against a concurrent accept', async () => {
    wireClient([
      { match: /SELECT \* FROM employee_invitations WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, result: { rows: [row()] } },
      { match: /UPDATE employee_invitations SET revoked_at/, result: { rows: [] } }, // lost the race
    ]);
    await expect(revokeInvitationById('inv-1', 'company-a', 'user-1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ---------------------------------------------------------------------------
// lockInvitationByRawTokenForUpdate — the primitive acceptInvitation() uses
// to make single-use enforcement race-safe.
// ---------------------------------------------------------------------------
describe('lockInvitationByRawTokenForUpdate', () => {
  it('issues a FOR UPDATE locked read by token hash', async () => {
    // Cast to bypass pg's overloaded `query` method signature -- this fake
    // client only needs to satisfy the function's own Pick<PoolClient,
    // 'query'> parameter type at the call site, not pg's real (and much
    // wider) overload set.
    const queryMock: any = vi.fn(async () => ({ rows: [row()] }));
    const client = { query: queryMock } as unknown as Parameters<typeof lockInvitationByRawTokenForUpdate>[0];
    const result = await lockInvitationByRawTokenForUpdate(client, 'rawtoken123');
    expect(result?.id).toBe('inv-1');
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/WHERE token_hash = \$1/);
  });

  it('returns null for an unknown token (never throws — callers decide what a missing invitation means)', async () => {
    const queryMock: any = vi.fn(async () => ({ rows: [] }));
    const client = { query: queryMock } as unknown as Parameters<typeof lockInvitationByRawTokenForUpdate>[0];
    const result = await lockInvitationByRawTokenForUpdate(client, 'nonexistent');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// acquireEmailLock — exported (production-review fix #2, 2026-09-09) so
// acceptInvitation() in auth.controller.ts can take the SAME per-email
// advisory lock create/resend use, in the same position, closing the race
// where a concurrent create/resend's unlocked "no account yet" read goes
// stale by the time it writes.
// ---------------------------------------------------------------------------
describe('acquireEmailLock', () => {
  it('issues a pg_advisory_xact_lock keyed by the given email', async () => {
    const queryMock: any = vi.fn(async () => ({ rows: [] }));
    const client = { query: queryMock };
    await acquireEmailLock(client, 'invitee@example.com');
    expect(queryMock).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['invitee@example.com']);
  });
});

// ---------------------------------------------------------------------------
// Static source-text regressions — the same technique email.test.ts's 42P08
// check uses: properties that are true of the SOURCE TEXT and would be
// expensive or impossible to catch with a mocked-pool unit test, because
// they're about which code paths exist / which real Postgres feature is
// invoked, not about return values.
// ---------------------------------------------------------------------------
describe('concurrency-safety source regressions', () => {
  const invitationsSource = fs.readFileSync(path.join(__dirname, '../invitations.ts'), 'utf-8');
  const authControllerSource = fs.readFileSync(path.join(__dirname, '../../controllers/auth.controller.ts'), 'utf-8');
  const usersControllerSource = fs.readFileSync(path.join(__dirname, '../../controllers/users.controller.ts'), 'utf-8');
  const migrationSource = fs.readFileSync(path.join(__dirname, '../../../docs/MIGRATION_077_employee_invitations.sql'), 'utf-8');

  it('every mutating invitation lifecycle path in invitations.ts takes a row lock or the email advisory lock', () => {
    expect(invitationsSource).toMatch(/pg_advisory_xact_lock/);
    // scanInvitationRowsForEmail, resend's re-scan, revoke's read, and the
    // token lookup used by accept must all lock the row(s) they read.
    const forUpdateCount = (invitationsSource.match(/FOR UPDATE/g) || []).length;
    expect(forUpdateCount).toBeGreaterThanOrEqual(3);
  });

  it('acceptInvitation() locks the invitation row inside its transaction instead of trusting the pre-check read', () => {
    expect(authControllerSource).toMatch(/lockInvitationByRawTokenForUpdate/);
    // The final accept mutation must be guarded, not unconditional.
    expect(authControllerSource).toMatch(/WHERE id = \$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW\(\)/);
  });

  it('acceptInvitation() takes the same per-email advisory lock as create/resend, in the same position — BEFORE locking the invitation row (production-review fix #2, 2026-09-09: consistent lock ordering across all four lifecycle operations closes the "stale users check" race)', () => {
    expect(authControllerSource).toMatch(/acquireEmailLock\(client, precheck\.email\)/);
    const lockIdx = authControllerSource.indexOf('acquireEmailLock(client, precheck.email)');
    const rowLockIdx = authControllerSource.indexOf('lockInvitationByRawTokenForUpdate(client, token)');
    expect(lockIdx).toBeGreaterThan(0);
    expect(rowLockIdx).toBeGreaterThan(lockIdx);
  });

  it('resendInvitationById re-checks for an existing users account inside its locked transaction before ever regenerating a token (production-review fix #3, 2026-09-09)', () => {
    const fnStart = invitationsSource.indexOf('export async function resendInvitationById');
    const fnBody = invitationsSource.slice(fnStart, invitationsSource.indexOf('\nexport async function revokeInvitationById'));
    const lockIdx = fnBody.indexOf('acquireEmailLock(client, email)');
    const userCheckIdx = fnBody.indexOf("FROM users WHERE email = $1");
    const tokenGenIdx = fnBody.indexOf('crypto.randomBytes(32)');
    expect(lockIdx).toBeGreaterThan(0);
    expect(userCheckIdx).toBeGreaterThan(lockIdx);
    expect(tokenGenIdx).toBeGreaterThan(userCheckIdx);
  });

  it('users.controller.ts blocks a manager from assigning admin/manager or touching an existing admin/manager account', () => {
    expect(usersControllerSource).toMatch(/req\.auth!\.role === 'manager'/);
    expect(usersControllerSource).toMatch(/Managers cannot modify admin or manager accounts/);
    expect(usersControllerSource).toMatch(/Managers cannot assign the admin or manager role/);
  });

  it('MIGRATION_077 lets an inviter/accepter/revoker be deleted without being blocked by this table', () => {
    const setNullCount = (migrationSource.match(/REFERENCES users\(id\) ON DELETE SET NULL/g) || []).length;
    expect(setNullCount).toBe(3); // invited_by, accepted_user_id, revoked_by
    expect(migrationSource).not.toMatch(/invited_by\s+UUID NOT NULL/);
  });
});
