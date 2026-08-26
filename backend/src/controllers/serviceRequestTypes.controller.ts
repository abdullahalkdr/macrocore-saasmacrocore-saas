import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

// ITSM pivot, Step 2 (MIGRATION_047 built the tables) — the specific
// services under a category (e.g. "Request new software" under
// "Applications"). is_hr_sensitive lives HERE, not on service_categories —
// it's what supportTickets.controller.ts's HR isolation actually reads once
// a ticket carries request_type_id (see that file's visibilityFilter()/
// canAccessTicket()). Same reasoning as MIGRATION_047's own header comment:
// "is this specific service HR-sensitive" is a request-type-level fact.

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { category_id } = req.query;

  const params: unknown[] = [companyId];
  let categoryFilter = '';
  if (typeof category_id === 'string') {
    params.push(category_id);
    categoryFilter = ` AND category_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, category_id, department_id, name, name_en, description, description_en, is_hr_sensitive, requires_approval, created_at, updated_at
     FROM service_request_types WHERE company_id = $1${categoryFilter} ORDER BY name`,
    params
  );
  const requestTypes = result.rows;

  // MIGRATION_072 — attach each request type's own approval step config (settings
  // page needs it to render the builder; SupportTicketsPage.tsx doesn't use this
  // list endpoint for approval data at all, it only ever reads the live chain via
  // GET /support/tickets/:id). One batched query beats N+1 per request type.
  const ids = requestTypes.map((r) => r.id);
  const stepsByType = new Map<string, unknown[]>();
  if (ids.length > 0) {
    const stepsResult = await pool.query(
      `SELECT rtas.request_type_id, rtas.step_number, rtas.approver_type, rtas.approver_job_role_id,
              rtas.step_label, rtas.step_label_en, jr.name AS approver_job_role_name, jr.name_en AS approver_job_role_name_en
       FROM request_type_approval_steps rtas
       LEFT JOIN job_roles jr ON jr.id = rtas.approver_job_role_id
       WHERE rtas.request_type_id = ANY($1::uuid[])
       ORDER BY rtas.request_type_id, rtas.step_number`,
      [ids]
    );
    for (const row of stepsResult.rows) {
      const arr = stepsByType.get(row.request_type_id) ?? [];
      arr.push(row);
      stepsByType.set(row.request_type_id, arr);
    }
  }

  res.status(200).json({
    success: true,
    requestTypes: requestTypes.map((rt) => ({ ...rt, approval_steps: stepsByType.get(rt.id) ?? [] })),
  });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { category_id, department_id, name, name_en, description, description_en, is_hr_sensitive } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (name_en !== undefined && name_en !== null && typeof name_en !== 'string') throw new AppError(400, 'name_en must be a string');
  if (description !== undefined && description !== null && typeof description !== 'string') throw new AppError(400, 'description must be a string');
  if (description_en !== undefined && description_en !== null && typeof description_en !== 'string') throw new AppError(400, 'description_en must be a string');
  if (is_hr_sensitive !== undefined && typeof is_hr_sensitive !== 'boolean') throw new AppError(400, 'is_hr_sensitive must be a boolean');

  // category_id is optional at the schema level (nullable FK) but validated
  // against the caller's own company when present — same cross-tenant check
  // pattern used throughout this codebase (ticket_categories/category_id,
  // etc.) since a plain FK can't enforce "same tenant" across two tables.
  let finalCategoryId: string | null = null;
  if (category_id !== undefined && category_id !== null) {
    if (typeof category_id !== 'string') throw new AppError(400, 'category_id must be a string');
    const catCheck = await pool.query('SELECT id FROM service_categories WHERE id = $1 AND company_id = $2', [category_id, companyId]);
    if (!catCheck.rows[0]) throw new AppError(400, 'category_id does not belong to this company');
    finalCategoryId = category_id;
  }

  // MIGRATION_071 — same optional, company-scoped-FK pattern as category_id
  // above. Which department "owns" this specific service (e.g. "مشكلة شبكة"
  // -> Networking & Telecom) — used client-side to suggest an assignee, see
  // that migration's header comment.
  let finalDepartmentId: string | null = null;
  if (department_id !== undefined && department_id !== null) {
    if (typeof department_id !== 'string') throw new AppError(400, 'department_id must be a string');
    const deptCheck = await pool.query('SELECT id FROM departments WHERE id = $1 AND company_id = $2', [department_id, companyId]);
    if (!deptCheck.rows[0]) throw new AppError(400, 'department_id does not belong to this company');
    finalDepartmentId = department_id;
  }

  const result = await pool.query(
    `INSERT INTO service_request_types (company_id, category_id, department_id, name, name_en, description, description_en, is_hr_sensitive)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, category_id, department_id, name, name_en, description, description_en, is_hr_sensitive, created_at, updated_at`,
    [
      companyId,
      finalCategoryId,
      finalDepartmentId,
      name.trim(),
      typeof name_en === 'string' ? name_en.trim() : null,
      typeof description === 'string' ? description.trim() : null,
      typeof description_en === 'string' ? description_en.trim() : null,
      is_hr_sensitive === true,
    ]
  );
  const requestType = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_request_type_created', entityType: 'service_request_types', entityId: requestType.id, req });

  res.status(201).json({ success: true, requestType });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { category_id, department_id, name, name_en, description, description_en, is_hr_sensitive } = req.body ?? {};

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) throw new AppError(400, 'name must be a non-empty string');
  if (name_en !== undefined && name_en !== null && typeof name_en !== 'string') throw new AppError(400, 'name_en must be a string');
  if (description !== undefined && description !== null && typeof description !== 'string') throw new AppError(400, 'description must be a string');
  if (description_en !== undefined && description_en !== null && typeof description_en !== 'string') throw new AppError(400, 'description_en must be a string');
  if (is_hr_sensitive !== undefined && typeof is_hr_sensitive !== 'boolean') throw new AppError(400, 'is_hr_sensitive must be a boolean');

  // category_id, unlike the rest of this endpoint's fields, is
  // explicit-null-vs-omitted aware — a request type can be moved to a
  // different category, or detached entirely (null). Same CASE WHEN pattern
  // supportTickets.controller.ts's updateStatus() uses for its own
  // category_id field.
  let touchesCategory = false;
  let nextCategoryId: string | null = null;
  if (category_id !== undefined) {
    touchesCategory = true;
    if (category_id !== null) {
      if (typeof category_id !== 'string') throw new AppError(400, 'category_id must be a string or null');
      const catCheck = await pool.query('SELECT id FROM service_categories WHERE id = $1 AND company_id = $2', [category_id, companyId]);
      if (!catCheck.rows[0]) throw new AppError(400, 'category_id does not belong to this company');
      nextCategoryId = category_id;
    }
  }

  // MIGRATION_071 — same explicit-null-vs-omitted CASE WHEN pattern as
  // category_id above.
  let touchesDepartment = false;
  let nextDepartmentId: string | null = null;
  if (department_id !== undefined) {
    touchesDepartment = true;
    if (department_id !== null) {
      if (typeof department_id !== 'string') throw new AppError(400, 'department_id must be a string or null');
      const deptCheck = await pool.query('SELECT id FROM departments WHERE id = $1 AND company_id = $2', [department_id, companyId]);
      if (!deptCheck.rows[0]) throw new AppError(400, 'department_id does not belong to this company');
      nextDepartmentId = department_id;
    }
  }

  const result = await pool.query(
    `UPDATE service_request_types
     SET category_id = CASE WHEN $1 THEN $2::uuid ELSE category_id END,
         department_id = CASE WHEN $3 THEN $4::uuid ELSE department_id END,
         name = COALESCE($5, name),
         name_en = COALESCE($6, name_en),
         description = COALESCE($7, description),
         description_en = COALESCE($8, description_en),
         is_hr_sensitive = COALESCE($9, is_hr_sensitive),
         updated_at = NOW()
     WHERE id = $10 AND company_id = $11
     RETURNING id, category_id, department_id, name, name_en, description, description_en, is_hr_sensitive, created_at, updated_at`,
    [
      touchesCategory,
      nextCategoryId,
      touchesDepartment,
      nextDepartmentId,
      typeof name === 'string' ? name.trim() : null,
      typeof name_en === 'string' ? name_en.trim() : null,
      typeof description === 'string' ? description.trim() : null,
      typeof description_en === 'string' ? description_en.trim() : null,
      typeof is_hr_sensitive === 'boolean' ? is_hr_sensitive : null,
      id,
      companyId,
    ]
  );
  if (!result.rows[0]) throw new AppError(404, 'Request type not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_request_type_updated', entityType: 'service_request_types', entityId: id as string, req });

  res.status(200).json({ success: true, requestType: result.rows[0] });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  // support_tickets.request_type_id is ON DELETE SET NULL (MIGRATION_047) —
  // same "never take a ticket down with it" behavior as category_id on
  // ticket_categories. service_custom_fields.request_type_id IS a cascade
  // (deleting a request type deletes its custom field definitions).
  const result = await pool.query(
    `DELETE FROM service_request_types WHERE id = $1 AND company_id = $2 RETURNING id`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Request type not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'service_request_type_deleted', entityType: 'service_request_types', entityId: id as string, req });

  res.status(200).json({ success: true });
});

// ========================================================================
// MIGRATION_072 — Approval Workflow configuration, per request type. Replaces
// the toggle/steps together, atomically, so requires_approval = true can never
// persist with zero configured steps (createItsmApprovalChain would silently
// no-op forever on such a request type otherwise — this endpoint refuses to
// create that state in the first place). See that migration's header for the
// full "why per-request-type, not global" reasoning.
// ========================================================================

interface ApprovalStepInput {
  approver_type: 'department_manager' | 'job_role';
  approver_job_role_id?: string | null;
  step_label: string;
  step_label_en?: string | null;
}

export const setApprovalSteps = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { requires_approval, steps } = req.body ?? {};

  const rtCheck = await pool.query('SELECT id FROM service_request_types WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!rtCheck.rows[0]) throw new AppError(404, 'Request type not found');

  if (typeof requires_approval !== 'boolean') throw new AppError(400, 'requires_approval must be a boolean');
  if (requires_approval && (!Array.isArray(steps) || steps.length === 0)) {
    throw new AppError(400, 'At least one approval step is required when requires_approval is true');
  }
  if (steps !== undefined && !Array.isArray(steps)) throw new AppError(400, 'steps must be an array');

  const finalSteps: ApprovalStepInput[] = requires_approval ? steps : [];

  for (const [i, raw] of finalSteps.entries()) {
    const stepNumber = i + 1;
    const s = raw as Partial<ApprovalStepInput>;
    if (s.approver_type !== 'department_manager' && s.approver_type !== 'job_role') {
      throw new AppError(400, `step ${stepNumber}: approver_type must be 'department_manager' or 'job_role'`);
    }
    if (typeof s.step_label !== 'string' || s.step_label.trim().length < 1) {
      throw new AppError(400, `step ${stepNumber}: step_label is required`);
    }
    if (s.approver_type === 'job_role') {
      if (typeof s.approver_job_role_id !== 'string' || !s.approver_job_role_id) {
        throw new AppError(400, `step ${stepNumber}: approver_job_role_id is required for a job_role step`);
      }
      const jrCheck = await pool.query('SELECT id FROM job_roles WHERE id = $1 AND company_id = $2', [s.approver_job_role_id, companyId]);
      if (!jrCheck.rows[0]) throw new AppError(400, `step ${stepNumber}: approver_job_role_id does not belong to this company`);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE service_request_types SET requires_approval = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3',
      [requires_approval, id, companyId]
    );
    await client.query('DELETE FROM request_type_approval_steps WHERE request_type_id = $1', [id]);
    for (const [i, s] of finalSteps.entries()) {
      await client.query(
        `INSERT INTO request_type_approval_steps (request_type_id, step_number, approver_type, approver_job_role_id, step_label, step_label_en)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          i + 1,
          s.approver_type,
          s.approver_type === 'job_role' ? s.approver_job_role_id : null,
          s.step_label.trim(),
          typeof s.step_label_en === 'string' && s.step_label_en.trim() ? s.step_label_en.trim() : null,
        ]
      );
    }
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
    action: 'service_request_type_approval_updated',
    entityType: 'service_request_types',
    entityId: id as string,
    req,
    newValues: { requires_approval, step_count: finalSteps.length },
  });

  res.status(200).json({ success: true });
});
