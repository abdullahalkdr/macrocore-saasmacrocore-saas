import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Source-text regression tests — Chat 3C's assigned-employee access
// prerequisite and its knock-on effects on supportTickets.controller.ts.
//
// Live behavioral verification (a real assigned employee getting 200 instead
// of 404 on GET /support/tickets/:id, a bystander still getting 404, etc.) is
// Abdullah's own live test against a real database — this sandbox has no DB
// network path (see backend/docs/SMOKE_*.js for the live-DB scripts he runs
// himself). These assert the fix is actually present and shaped correctly in
// the shipped source, the same style every other regression test in this
// repo already uses (approvals.controller.test.ts, expensesOwnerEditGuard.
// test.ts).
//
// Cross-tenant denial is asserted at the query boundary (company_id = $2 on
// every ticket-fetch query) per Abdullah's explicit correction — NOT as a
// canAccessTicket() unit test, since that helper intentionally has no
// companyId parameter and cannot itself express tenant isolation.
// ---------------------------------------------------------------------------
describe('supportTickets.controller.ts — assigned-employee access prerequisite (Chat 3C)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../supportTickets.controller.ts'), 'utf-8');

  function extractFn(name: string): string {
    const marker = `export const ${name} = asyncHandler(`;
    const start = source.indexOf(marker);
    if (start === -1) throw new Error(`extractFn: ${name} not found in source`);
    const nextExport = source.indexOf('\nexport const ', start + marker.length);
    return nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
  }

  describe('tenant isolation at the query boundary — every ticket-fetch query scopes to the caller\'s own company', () => {
    it('getOne() scopes its ticket lookup to t.company_id = $2', () => {
      const getOne = extractFn('getOne');
      expect(getOne).toMatch(/WHERE t\.id = \$1 AND t\.company_id = \$2/);
    });

    it('reply() scopes its ticket lookup to t.company_id = $2', () => {
      const reply = extractFn('reply');
      expect(reply).toMatch(/WHERE t\.id = \$1 AND t\.company_id = \$2/);
    });

    it('updateStatus() scopes its ticket lookup to t.company_id = $2, and its UPDATE to company_id = $11 (Stage 4 — guarded against a lost-race reopen)', () => {
      const updateStatus = extractFn('updateStatus');
      expect(updateStatus).toMatch(/WHERE t\.id = \$1 AND t\.company_id = \$2/);
      expect(updateStatus).toContain("WHERE id = $10 AND company_id = $11 AND (NOT $8 OR status IN ('resolved', 'closed'))");
    });
  });

  describe('reply() and updateStatus() now select t.assigned_to so canAccessTicket() can see it', () => {
    it('reply()\'s ticket lookup includes t.assigned_to', () => {
      const reply = extractFn('reply');
      const select = reply.slice(reply.indexOf('await pool.query'), reply.indexOf('WHERE t.id = $1'));
      expect(select).toContain('t.assigned_to');
    });

    it('updateStatus()\'s existing-ticket lookup includes t.assigned_to AND t.status (the old status, needed for the Stage 3 no-op comparison)', () => {
      const updateStatus = extractFn('updateStatus');
      const select = updateStatus.slice(updateStatus.indexOf('const existing'), updateStatus.indexOf('WHERE t.id = $1'));
      expect(select).toContain('t.assigned_to');
      expect(select).toContain('t.status');
    });
  });

  it('getOne() needs no SELECT change — TICKET_FIELDS_QUALIFIED already carries assigned_to and created_by', () => {
    expect(source).toContain('assigned_to, created_by');
    const getOne = extractFn('getOne');
    expect(getOne).toContain('TICKET_FIELDS_QUALIFIED');
  });

  describe('internal-note scrubbing broadened from "plain creator" to every plain-employee-role caller', () => {
    it('getOne() gates the filter on role alone (isPlainEmployee), not on also being the creator', () => {
      const getOne = extractFn('getOne');
      expect(getOne).toContain("const isPlainEmployee = req.auth!.role === 'employee';");
      expect(getOne).toContain('isPlainEmployee ? repliesResult.rows.filter((r) => !r.is_internal_note) : repliesResult.rows');
      // The old creator-scoped variable name must be gone — this is a real
      // behavior change (assignee + any other plain-employee viewer are now
      // scrubbed too), not just a rename.
      expect(getOne).not.toContain('isPlainCreator');
    });
  });

  describe('category_id mutation guard — Option B, folded into the existing hard-403 check', () => {
    it('the hard-403 canManageTicketStatus() guard now also covers category_id', () => {
      const updateStatus = extractFn('updateStatus');
      expect(updateStatus).toContain(
        "if ((status !== undefined || priority !== undefined || category_id !== undefined) && !(await canManageTicketStatus(req.auth!))) {"
      );
      expect(updateStatus).toContain('Only IT staff, managers, and admins can change a ticket status, priority, or category.');
      // The old two-field-only guard text must be gone, not left as a second
      // dead branch alongside the new one.
      expect(updateStatus).not.toContain('Only IT staff, managers, and admins can change a ticket status or priority.');
    });

    it('assigned_to is NOT part of this hard-403 guard — it keeps its own separate silent-ignore-if-unauthorized convention', () => {
      const updateStatus = extractFn('updateStatus');
      const guardLine = updateStatus.slice(
        updateStatus.indexOf('if ((status !== undefined'),
        updateStatus.indexOf("throw new AppError(403,") + 50
      );
      expect(guardLine).not.toContain('assigned_to');
    });
  });

  describe('canAccessTicket() call sites unchanged in shape — still one shared policy, no controller-local duplicate', () => {
    it('getOne(), reply(), and updateStatus() all still gate on the shared canAccessTicket(), 404 (not 403) on denial', () => {
      expect((source.match(/if \(!\(await canAccessTicket\(req\.auth!, [\w.[\]]+\)\)\) throw new AppError\(404, 'Ticket not found'\);/g) ?? []).length).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // reply() — public reply direction (Chat 3C follow-up, then narrowed further).
  // Now that a plain-employee assignee can open and reply to a ticket, role
  // alone ('admin' || 'manager') is no longer a correct proxy for "is this a
  // support-side reply?" — an assigned employee's reply must be support-side
  // too, and an admin/manager replying on THEIR OWN ticket must be
  // requester-side. But a plain "not the creator" check overshoots: this route
  // is authenticated-only and canAccessTicket() falls through to true for any
  // non-employee role (e.g. 'viewer') on a non-HR ticket, so that alone would
  // newly make a viewer's reply on someone else's ticket support-side and let
  // it stamp first_response_at — a real scope leak this prerequisite must NOT
  // introduce. Support-side is therefore exactly: not the creator, AND
  // (admin/manager, OR an employee who is this ticket's assigned_to).
  // Internal-note AUTHORIZATION stays role-only and fully separate from all of
  // this. Viewer route/ticket-access scope itself is untouched — a separate,
  // not-yet-made policy decision, not broadened here either way.
  // ---------------------------------------------------------------------------
  describe('reply() — public reply direction driven by ticket relationship, not role (Chat 3C follow-up)', () => {
    const reply = extractFn('reply');

    // The exact isStaffReply expression as shipped, extracted from source and
    // made independently executable (stripping only the TypeScript non-null
    // assertions, which are erased at compile time and mean nothing at
    // runtime) — this proves the real truth table of the actual shipped
    // logic, not just that certain substrings appear in it.
    function buildIsStaffReply(): (ticket: { created_by: string; assigned_to: string | null }, auth: { userId: string; role: string }) => boolean {
      const match = reply.match(/const isStaffReply =([\s\S]*?);/);
      expect(match).not.toBeNull();
      const rawExpr = match![1];
      const jsExpr = rawExpr.replace(/req\.auth!/g, 'req.auth');
      // eslint-disable-next-line no-new-func
      const fn = new Function('ticket', 'req', `return (${jsExpr});`) as (t: unknown, r: unknown) => boolean;
      return (t, r) => fn({ rows: [t] }, { auth: r });
    }

    it('the old role-only proxy is gone entirely — not just renamed', () => {
      expect(reply).not.toContain("const isAdminReply = req.auth!.role === 'admin' || req.auth!.role === 'manager';");
      expect(reply).not.toMatch(/\bisAdminReply\b/);
      expect(reply).toContain('const isStaffReply =');
    });

    it('a plain "not the creator" check alone is NOT the formula — assigned_to/role are both consulted', () => {
      const match = reply.match(/const isStaffReply =([\s\S]*?);/);
      const expr = match![1];
      expect(expr).toContain('created_by !== req.auth!.userId');
      expect(expr).toContain("req.auth!.role === 'admin'");
      expect(expr).toContain("req.auth!.role === 'manager'");
      expect(expr).toContain("req.auth!.role === 'employee'");
      expect(expr).toContain('assigned_to === req.auth!.userId');
    });

    describe('real truth table of the shipped isStaffReply expression', () => {
      const isStaffReply = buildIsStaffReply();

      it('assigned employee + non-creator -> support-side (true)', () => {
        expect(
          isStaffReply({ created_by: 'requester-1', assigned_to: 'emp-1' }, { userId: 'emp-1', role: 'employee' })
        ).toBe(true);
      });

      it('admin + non-creator -> support-side (true), regardless of assigned_to', () => {
        expect(
          isStaffReply({ created_by: 'requester-1', assigned_to: null }, { userId: 'admin-1', role: 'admin' })
        ).toBe(true);
      });

      it('manager + non-creator -> support-side (true), regardless of assigned_to', () => {
        expect(
          isStaffReply({ created_by: 'requester-1', assigned_to: 'someone-else' }, { userId: 'mgr-1', role: 'manager' })
        ).toBe(true);
      });

      it('the creator is requester-side (false) no matter their role — admin, manager, or employee', () => {
        expect(isStaffReply({ created_by: 'user-1', assigned_to: null }, { userId: 'user-1', role: 'admin' })).toBe(false);
        expect(isStaffReply({ created_by: 'user-1', assigned_to: null }, { userId: 'user-1', role: 'manager' })).toBe(false);
        expect(isStaffReply({ created_by: 'user-1', assigned_to: 'user-1' }, { userId: 'user-1', role: 'employee' })).toBe(false);
      });

      it('an unassigned plain-employee bystander (non-creator, not the assignee) -> requester-side (false)', () => {
        expect(
          isStaffReply({ created_by: 'requester-1', assigned_to: 'someone-else' }, { userId: 'emp-1', role: 'employee' })
        ).toBe(false);
      });

      it('a viewer replying to someone else\'s ticket does NOT newly become support-side (false) — the scope leak this fix specifically avoids', () => {
        expect(
          isStaffReply({ created_by: 'requester-1', assigned_to: null }, { userId: 'viewer-1', role: 'viewer' })
        ).toBe(false);
        // Also true when the ticket happens to be assigned to someone else —
        // a viewer is never the assignee-match branch since that branch is
        // gated on role === 'employee'.
        expect(
          isStaffReply({ created_by: 'requester-1', assigned_to: 'viewer-1' }, { userId: 'viewer-1', role: 'viewer' })
        ).toBe(false);
      });
    });

    it('keeps internal-note authorization role-only and fully independent of isStaffReply', () => {
      expect(reply).toContain("const canWriteInternalNote = req.auth!.role === 'admin' || req.auth!.role === 'manager';");
      expect(reply).toContain('const finalIsInternalNote = canWriteInternalNote && is_internal_note === true;');
      // An assigned plain employee is support-side (isStaffReply) but must never
      // be able to write an internal note — the internal-note gate must not
      // reference isStaffReply anywhere. Sliced up to the Stage 3 helpdesk-email
      // block (not all the way to the INSERT) — that later block legitimately
      // reads isStaffReply to pick the email event, which is a separate,
      // intentional concern from this authorization gate, not a regression of it.
      const internalNoteLine = reply.slice(
        reply.indexOf('const canWriteInternalNote'),
        reply.indexOf('// Stage 3 — which (if any) Helpdesk email event')
      );
      expect(internalNoteLine).not.toContain('isStaffReply');
    });

    it('writes isStaffReply (not role) into the stored is_admin_reply column — no migration/rename, same column', () => {
      const insertBlock = reply.slice(reply.indexOf('INSERT INTO ticket_replies'), reply.indexOf('RETURNING') + 200);
      expect(insertBlock).toContain('is_admin_reply');
      expect(insertBlock).toContain('isStaffReply, finalIsInternalNote');
    });

    it('gates the first_response_at stamp on isStaffReply, not on role', () => {
      expect(reply).toContain('if (isStaffReply && !finalIsInternalNote && !ticket.rows[0].first_response_at) {');
    });
  });
});
