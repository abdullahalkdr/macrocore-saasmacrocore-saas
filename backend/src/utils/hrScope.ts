import { pool } from '../db/pool';

// Department-scoped visibility for HR-sensitive data (employees, attendance,
// leave requests, performance scores) and for the account-administration
// "Users" list — added 2026-08-26 after a live finding: every one of these
// endpoints was either open to any authenticated role (Users list) or only
// distinguished 'employee' (forced to their own record) from
// admin/manager (unrestricted, company-wide) — a manager of ANY department
// could see every other department's full employee roster, attendance,
// leave requests, and performance scores, with no department boundary at
// all. Real companies don't work this way: a department manager manages
// their own team, HR (and the owner) sees the whole company, and IT handles
// account/access administration but not HR-sensitive personal data.
//
// Design (locked in with Abdullah via AskUserQuestion before this was
// written — see claude/it-department-structure-context-handoff.md):
//   1. admin role, OR anyone whose own department (or an ancestor division)
//      is the company's HR department -> 'full' scope, same as today's
//      unrestricted admin/manager behavior.
//   2. Any other 'manager' -> 'department' scope: their own department plus
//      every descendant department (so a division head sees their whole
//      sub-org, not just their exact department row).
//   3. Everyone else ('employee' role, or a manager with no department set
//      at all) -> 'self' scope: only their own record, same as the
//      pre-existing employee-only ownership filter these controllers
//      already had.
// HR/IT membership is resolved from the REAL department tree (code prefix
// or legacy flat name_en — same convention departmentTemplates.ts's
// DEPARTMENT_TEMPLATES registry uses), not a role or job-title string, so
// it keeps working correctly whether a company loaded the HR/IT department
// templates or set up their own departments by hand.

export type HrScope =
  | { level: 'full' }
  | { level: 'department'; departmentIds: string[] }
  | { level: 'self'; employeeId: string | null };

async function resolveOwnDepartmentId(companyId: string, userId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT e.department_id
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id AND e.company_id = u.company_id
     WHERE u.id = $1 AND u.company_id = $2`,
    [userId, companyId]
  );
  return result.rows[0]?.department_id ?? null;
}

async function resolveOwnEmployeeId(companyId: string, userId: string): Promise<string | null> {
  const result = await pool.query(`SELECT employee_id FROM users WHERE id = $1 AND company_id = $2`, [userId, companyId]);
  return result.rows[0]?.employee_id ?? null;
}

// Walks parent_department_id upward from departmentId; true if departmentId
// itself or any ancestor matches the given code prefix (e.g. 'HR', 'IT') or
// legacy flat name_en (e.g. 'Human Resources', 'IT') — the same matching
// convention departmentTemplates.ts's legacyNames use, so this recognizes a
// department whether it came from a template or was set up by hand.
async function isWithinDepartmentCategory(
  companyId: string,
  departmentId: string | null,
  codePrefix: string,
  legacyNameEn: string
): Promise<boolean> {
  let currentId = departmentId;
  const seen = new Set<string>();
  while (currentId) {
    if (seen.has(currentId)) return false; // corrupt/cyclic data — don't loop forever
    seen.add(currentId);
    const result = await pool.query(
      `SELECT code, name_en, parent_department_id FROM departments WHERE id = $1 AND company_id = $2`,
      [currentId, companyId]
    );
    const dept = result.rows[0] as { code: string | null; name_en: string; parent_department_id: string | null } | undefined;
    if (!dept) return false;
    if ((dept.code && dept.code.startsWith(codePrefix)) || dept.name_en === legacyNameEn) return true;
    currentId = dept.parent_department_id;
  }
  return false;
}

// A department's own id plus every descendant id, via a recursive walk down
// parent_department_id — a manager's "own team" for department-scoped
// visibility (their exact department plus any sub-sections under it).
async function departmentAndDescendantIds(companyId: string, rootDepartmentId: string): Promise<string[]> {
  const result = await pool.query(
    `WITH RECURSIVE tree AS (
       SELECT id FROM departments WHERE id = $1 AND company_id = $2
       UNION ALL
       SELECT d.id FROM departments d JOIN tree t ON d.parent_department_id = t.id WHERE d.company_id = $2
     )
     SELECT id FROM tree`,
    [rootDepartmentId, companyId]
  );
  return result.rows.map((r) => r.id as string);
}

export async function getHrScope(companyId: string, userId: string, role: string): Promise<HrScope> {
  if (role === 'admin') return { level: 'full' };

  const departmentId = await resolveOwnDepartmentId(companyId, userId);
  if (await isWithinDepartmentCategory(companyId, departmentId, 'HR', 'Human Resources')) {
    return { level: 'full' };
  }

  if (role === 'manager' && departmentId) {
    const departmentIds = await departmentAndDescendantIds(companyId, departmentId);
    return { level: 'department', departmentIds };
  }

  const employeeId = await resolveOwnEmployeeId(companyId, userId);
  return { level: 'self', employeeId };
}

// Users/accounts administration (GET /users) — separate from getHrScope
// since it's not HR-sensitive personal data, it's account/access
// administration, an IT function in real companies (same "IT Support
// Technician... creates accounts, resets passwords" responsibility text
// from the researched IT department template). admin always; otherwise
// only someone within the IT department (any role, per Abdullah's
// decision — not IT managers only).
export async function canAccessUsersList(companyId: string, userId: string, role: string): Promise<boolean> {
  if (role === 'admin') return true;
  const departmentId = await resolveOwnDepartmentId(companyId, userId);
  return isWithinDepartmentCategory(companyId, departmentId, 'IT', 'IT');
}

// Returns true if `employeeId` (an employee row belonging to this company) falls
// within the given HrScope: any employee under 'full', only the caller's own
// department subtree under 'department', or only the caller's own record under
// 'self'. Looks up the employee's department_id fresh on every call (never trust
// a cached/client-supplied value). Used by every controller that gates a WRITE
// to one specific employee's row (leaveRequests, attendance, performanceScores)
// the same way list()/getOne() already gate reads — added 2026-08-27 after an
// audit found those write paths had no scope check at all, only requireRole.
export async function isEmployeeInHrScope(companyId: string, scope: HrScope, employeeId: string | null): Promise<boolean> {
  if (scope.level === 'full') return true;
  if (!employeeId) return false;
  if (scope.level === 'self') return scope.employeeId === employeeId;
  const result = await pool.query('SELECT department_id FROM employees WHERE id = $1 AND company_id = $2', [employeeId, companyId]);
  const departmentId: string | null = result.rows[0]?.department_id ?? null;
  return !!departmentId && scope.departmentIds.includes(departmentId);
}
