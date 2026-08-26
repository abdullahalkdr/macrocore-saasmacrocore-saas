import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { applyItDepartmentTemplate } from '../utils/itDepartmentTemplate';

// Dynamic, per-company corporate departments (MIGRATION_048), upgraded to an
// Enterprise "Corporate Departments" model by MIGRATION_049: a simple
// parent/child org hierarchy, a manager (an employees row), a free-text cost
// center tag, an active/inactive status, and department-scoped job_roles
// (moved out of the old hardcoded frontend catalog — see job_roles CRUD
// below). GET stays open to any authenticated role (an employee's own
// department shows up in the support ticket assignee list, and any employee
// filling out their own profile may need to read the list/pick a role);
// POST/PATCH/DELETE on departments and their roles stay admin/manager only —
// same split serviceCategories.routes.ts uses for its own company-config
// resource.
//
// Unlike service_categories -> service_request_types, deleting a department
// does NOT cascade — employees.department_id and departments.parent_department_id
// are both ON DELETE SET NULL (MIGRATION_048 decision 4 / MIGRATION_049
// decision 1), so remove() below is a plain delete: employees under it lose
// the label, child departments are promoted to root level, nothing is
// silently destroyed.

const STATUSES = ['active', 'inactive'];

interface DeptRow {
  id: string;
  name: string;
  name_en: string;
  code: string | null;
  parent_department_id: string | null;
  manager_id: string | null;
  cost_center_code: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  manager_emp_id: string | null;
  manager_name: string | null;
  employee_count: string; // numeric from COUNT(), cast below
  roles: { id: string; name: string; name_en: string | null }[];
}

// Builds the Parent -> Children tree from a flat, already-aggregated row set.
// A row whose parent isn't present in this company's own set (parent_department_id
// null, or — defensively — pointing outside this result set) becomes a root.
function buildDepartmentTree(rows: DeptRow[]) {
  const byId = new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        name_en: r.name_en,
        code: r.code,
        parent_department_id: r.parent_department_id,
        manager_id: r.manager_id,
        manager: r.manager_emp_id ? { id: r.manager_emp_id, name: r.manager_name } : null,
        cost_center_code: r.cost_center_code,
        status: r.status,
        employee_count: Number(r.employee_count) || 0,
        roles: r.roles,
        created_at: r.created_at,
        updated_at: r.updated_at,
        children: [] as unknown[],
      },
    ])
  );
  const roots: unknown[] = [];
  for (const node of byId.values()) {
    if (node.parent_department_id && byId.has(node.parent_department_id)) {
      (byId.get(node.parent_department_id) as { children: unknown[] }).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query<DeptRow>(
    `SELECT
       d.id, d.name, d.name_en, d.code, d.parent_department_id, d.manager_id, d.cost_center_code, d.status,
       d.created_at, d.updated_at,
       m.id AS manager_emp_id, m.name AS manager_name,
       COUNT(DISTINCT e.id) AS employee_count,
       COALESCE(
         json_agg(DISTINCT jsonb_build_object('id', jr.id, 'name', jr.name, 'name_en', jr.name_en))
           FILTER (WHERE jr.id IS NOT NULL),
         '[]'
       ) AS roles
     FROM departments d
     LEFT JOIN employees m ON m.id = d.manager_id AND m.company_id = d.company_id
     LEFT JOIN employees e ON e.department_id = d.id AND e.company_id = d.company_id
     LEFT JOIN job_roles jr ON jr.department_id = d.id AND jr.company_id = d.company_id
     WHERE d.company_id = $1
     GROUP BY d.id, m.id, m.name
     ORDER BY d.name`,
    [companyId]
  );
  res.status(200).json({ success: true, departments: buildDepartmentTree(result.rows) });
});

// Walks parent_department_id up from `startId`; true if `targetId` is among its
// ancestors (or is startId itself) — used to reject a parent assignment that
// would turn the tree into a cycle.
async function isAncestorOrSelf(companyId: string, startId: string, targetId: string): Promise<boolean> {
  let currentId: string | null = startId;
  const seen = new Set<string>();
  while (currentId) {
    if (currentId === targetId) return true;
    if (seen.has(currentId)) return false; // already-corrupt data; don't loop forever
    seen.add(currentId);
    const row = await pool.query(
      'SELECT parent_department_id FROM departments WHERE id = $1 AND company_id = $2',
      [currentId, companyId]
    );
    const nextRow = row.rows[0] as { parent_department_id: string | null } | undefined;
    currentId = nextRow?.parent_department_id ?? null;
  }
  return false;
}

async function assertValidManager(companyId: string, managerId: string): Promise<void> {
  const emp = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [managerId, companyId]);
  if (!emp.rows[0]) throw new AppError(400, 'manager_id not found');
}

async function assertValidParent(companyId: string, parentId: string, selfId: string | null): Promise<void> {
  const dept = await pool.query('SELECT id FROM departments WHERE id = $1 AND company_id = $2', [parentId, companyId]);
  if (!dept.rows[0]) throw new AppError(400, 'parent_department_id not found');
  if (selfId) {
    if (parentId === selfId) throw new AppError(400, 'A department cannot be its own parent');
    if (await isAncestorOrSelf(companyId, parentId, selfId)) {
      throw new AppError(400, 'That parent would create a circular department hierarchy');
    }
  }
}

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, name_en, code, parent_department_id, manager_id, cost_center_code, status } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (typeof name_en !== 'string' || name_en.trim().length < 1) throw new AppError(400, 'name_en is required');
  if (status !== undefined && !STATUSES.includes(status)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);
  if (code !== undefined && code !== null) {
    if (typeof code !== 'string') throw new AppError(400, 'code must be a string');
    if (code.trim().length > 10) throw new AppError(400, 'code must be 10 characters or fewer');
  }
  if (parent_department_id) await assertValidParent(companyId, parent_department_id, null);
  if (manager_id) await assertValidManager(companyId, manager_id);

  const result = await pool.query(
    `INSERT INTO departments (company_id, name, name_en, code, parent_department_id, manager_id, cost_center_code, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, name_en, code, parent_department_id, manager_id, cost_center_code, status, created_at, updated_at`,
    [
      companyId,
      name.trim(),
      name_en.trim(),
      typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : null,
      parent_department_id || null,
      manager_id || null,
      cost_center_code || null,
      status || 'active',
    ]
  );
  const department = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'department_created', entityType: 'departments', entityId: department.id, req });

  res.status(201).json({ success: true, department });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, name_en, code, parent_department_id, manager_id, cost_center_code, status } = req.body ?? {};

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) throw new AppError(400, 'name must be a non-empty string');
  if (name_en !== undefined && (typeof name_en !== 'string' || name_en.trim().length < 1)) throw new AppError(400, 'name_en must be a non-empty string');
  if (status !== undefined && !STATUSES.includes(status)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);
  if (code !== undefined && code !== null) {
    if (typeof code !== 'string') throw new AppError(400, 'code must be a string');
    if (code.trim().length > 10) throw new AppError(400, 'code must be 10 characters or fewer');
  }
  if (parent_department_id !== undefined && parent_department_id !== null) await assertValidParent(companyId, parent_department_id, id as string);
  if (manager_id !== undefined && manager_id !== null) await assertValidManager(companyId, manager_id);

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (name !== undefined) { sets.push(`name = $${i++}`); values.push(name.trim()); }
  if (name_en !== undefined) { sets.push(`name_en = $${i++}`); values.push(name_en.trim()); }
  if (code !== undefined) { sets.push(`code = $${i++}`); values.push(typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : null); }
  if (parent_department_id !== undefined) { sets.push(`parent_department_id = $${i++}`); values.push(parent_department_id || null); }
  if (manager_id !== undefined) { sets.push(`manager_id = $${i++}`); values.push(manager_id || null); }
  if (cost_center_code !== undefined) { sets.push(`cost_center_code = $${i++}`); values.push(cost_center_code || null); }
  if (status !== undefined) { sets.push(`status = $${i++}`); values.push(status); }
  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE departments SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++}
     RETURNING id, name, name_en, code, parent_department_id, manager_id, cost_center_code, status, created_at, updated_at`,
    values
  );
  if (!result.rows[0]) throw new AppError(404, 'Department not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'department_updated', entityType: 'departments', entityId: id as string, req });

  res.status(200).json({ success: true, department: result.rows[0] });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(`DELETE FROM departments WHERE id = $1 AND company_id = $2 RETURNING id`, [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Department not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'department_deleted', entityType: 'departments', entityId: id as string, req });

  res.status(200).json({ success: true });
});

// ========================================================================
// IT Department Template (MIGRATION_069) — admin-triggered, replaces any
// existing "IT"-named department tree for this company with the full 8-
// division / section / job-title structure researched in
// claude/it-department-structure-context-handoff.md. New companies get this
// automatically at signup (auth.controller.ts); existing companies opt in
// here. Runs in its own transaction (not nested in the outer request's pool)
// since this is the only write in the request.
// ========================================================================

export const applyItTemplate = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await applyItDepartmentTemplate(client, companyId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'it_department_template_applied',
    entityType: 'departments',
    entityId: companyId,
    req,
    newValues: { ...result } as Record<string, unknown>,
  });

  res.status(200).json({ success: true, ...result });
});

// ========================================================================
// job_roles (MIGRATION_049) — department-scoped job titles, replacing the
// old hardcoded frontend catalog. Nested under departments the same way
// okr_key_results nests under okr_objectives: list/create take the parent
// department id from the route, update/remove address the role directly by
// its own id (see departments.routes.ts).
// ========================================================================

export const listRoles = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id: departmentId } = req.params;
  const result = await pool.query(
    `SELECT id, department_id, name, name_en, created_at, updated_at FROM job_roles
     WHERE department_id = $1 AND company_id = $2 ORDER BY name`,
    [departmentId, companyId]
  );
  res.status(200).json({ success: true, roles: result.rows });
});

export const createRole = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id: departmentId } = req.params;
  const { name, name_en } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');

  const dept = await pool.query('SELECT id FROM departments WHERE id = $1 AND company_id = $2', [departmentId, companyId]);
  if (!dept.rows[0]) throw new AppError(404, 'Department not found');

  const result = await pool.query(
    `INSERT INTO job_roles (company_id, department_id, name, name_en) VALUES ($1, $2, $3, $4)
     RETURNING id, department_id, name, name_en, created_at, updated_at`,
    [companyId, departmentId, name.trim(), typeof name_en === 'string' && name_en.trim() ? name_en.trim() : null]
  );
  const role = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'job_role_created', entityType: 'job_roles', entityId: role.id, req });

  res.status(201).json({ success: true, role });
});

export const updateRole = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, name_en } = req.body ?? {};

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) throw new AppError(400, 'name must be a non-empty string');

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (name !== undefined) { sets.push(`name = $${i++}`); values.push(name.trim()); }
  if (name_en !== undefined) { sets.push(`name_en = $${i++}`); values.push(typeof name_en === 'string' && name_en.trim() ? name_en.trim() : null); }
  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE job_roles SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++}
     RETURNING id, department_id, name, name_en, created_at, updated_at`,
    values
  );
  if (!result.rows[0]) throw new AppError(404, 'Job role not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'job_role_updated', entityType: 'job_roles', entityId: id as string, req });

  res.status(200).json({ success: true, role: result.rows[0] });
});

export const removeRole = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query('DELETE FROM job_roles WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Job role not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'job_role_deleted', entityType: 'job_roles', entityId: id as string, req });

  res.status(200).json({ success: true });
});
