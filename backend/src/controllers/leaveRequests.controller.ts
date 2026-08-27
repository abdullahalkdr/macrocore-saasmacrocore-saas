import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { isForeignKeyViolation } from '../utils/dbErrors';
import { logAudit } from '../utils/audit';
import { notifyRoles } from '../utils/notifications';
import { getOwnEmployeeId } from '../utils/ownEmployee';
import { getHrScope, isEmployeeInHrScope } from '../utils/hrScope';

// "Absences" — two sub-sections. category='leave' uses LEAVE_TYPES for `type`.
// category='absence_permission' pins `type` to the fixed 'permission' value and
// instead uses the structured permission_reason ("السبب") + notice_received_by.
const CATEGORIES = ['leave', 'absence_permission'];
const LEAVE_TYPES = [
  'azaa_leave',
  'annual_leave',
  'covid_19',
  'hajj_leave',
  'marriage_leave',
  'paternity_leave',
  'sick_leave',
  'study_leave',
];
const PERMISSION_REASONS = ['accident', 'death_in_family', 'medical_appointment', 'sick_family', 'sick_self', 'transportation', 'others'];
const NOTICE_RECEIVED_BY = ['in_person', 'other_employee', 'phone', 'relative', 'written'];
// Accepted on update() only, where callers may still send either an old or new type.
const TYPES_ALL = [...LEAVE_TYPES, 'permission'];

// Business rules (product decision): only restrict plain 'employee' self-service
// requests — admins/managers can still enter longer/manual exceptions on someone's
// behalf (e.g. an HR-approved override for a leave longer than the normal cap).
const LEAVE_DAY_BLOCK_THRESHOLD = 30; // strictly more than this many consecutive calendar days is blocked
const LEAVE_MAX_DAYS_MESSAGE =
  'الحد الأقصى للإجازات هو 30 يوم عمل متواصل. لأكثر من ذلك، تواصل مباشرة مع إدارة الموارد البشرية لإدخالها يدويًا في حال الموافقة.';
const PERMISSION_MAX_HOURS = 3;
const PERMISSION_MAX_HOURS_MESSAGE = 'الحد الأقصى للاستئذان هو 3 ساعات.';

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { start_date, end_date, start_time, end_time, reason, attachment_base64 } = req.body ?? {};
  let { employee_id, category, type, permission_reason, notice_received_by } = req.body ?? {};

  // Security fix (code audit finding #2): create() used to trust employee_id straight
  // from the request body with no check against the caller's identity — any logged-in
  // employee could file a leave/sick-leave request AS a coworker. Same fix pattern as
  // attendance.controller.ts (finding #1): pin a plain 'employee' caller to their own
  // linked employee record, ignoring whatever employee_id the client sent.
  if (req.auth!.role === 'employee') {
    employee_id = await getOwnEmployeeId(req.auth!.userId, companyId);
  }

  if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id is required');

  // Security fix (tenant-isolation audit, finding C1): admin/manager-supplied
  // employee_id was inserted with no company check at all — a plain 'employee' caller
  // is already pinned to their own record above, but admin/manager could previously
  // file a leave_requests row for ANY employee UUID in the database, including one
  // belonging to a different company. Same write-time check every other controller
  // already runs on its own FK inputs (assertManagerInCompany, department checks, etc.).
  if (req.auth!.role !== 'employee') {
    const employeeCheck = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [employee_id, companyId]);
    if (employeeCheck.rows.length === 0) throw new AppError(400, 'employee_id not found');
  }

  if (typeof category !== 'string' || !CATEGORIES.includes(category)) {
    throw new AppError(400, `category must be one of ${CATEGORIES.join(', ')}`);
  }

  let finalType: string;
  let finalPermissionReason: string | null = null;
  let finalNoticeReceivedBy: string | null = null;

  if (category === 'leave') {
    if (typeof type !== 'string' || !LEAVE_TYPES.includes(type)) throw new AppError(400, `type must be one of ${LEAVE_TYPES.join(', ')}`);
    finalType = type;
  } else {
    finalType = 'permission';
    if (typeof permission_reason !== 'string' || !PERMISSION_REASONS.includes(permission_reason)) {
      throw new AppError(400, `permission_reason must be one of ${PERMISSION_REASONS.join(', ')}`);
    }
    if (typeof notice_received_by !== 'string' || !NOTICE_RECEIVED_BY.includes(notice_received_by)) {
      throw new AppError(400, `notice_received_by must be one of ${NOTICE_RECEIVED_BY.join(', ')}`);
    }
    if (typeof start_time !== 'string' || !start_time) throw new AppError(400, 'start_time is required for an absence permission');
    if (typeof end_time !== 'string' || !end_time) throw new AppError(400, 'end_time is required for an absence permission');
    finalPermissionReason = permission_reason;
    finalNoticeReceivedBy = notice_received_by;
  }

  if (typeof start_date !== 'string') throw new AppError(400, 'start_date is required (YYYY-MM-DD)');

  // Employee self-service caps (see constants above) — admins/managers are exempt so
  // they can still key in an HR-approved exception manually.
  if (req.auth!.role === 'employee') {
    if (category === 'leave' && typeof end_date === 'string' && end_date) {
      const days = Math.round((new Date(end_date).getTime() - new Date(start_date).getTime()) / 86400000) + 1;
      if (days > LEAVE_DAY_BLOCK_THRESHOLD) throw new AppError(400, LEAVE_MAX_DAYS_MESSAGE);
    }
    if (category === 'absence_permission' && typeof start_time === 'string' && typeof end_time === 'string') {
      const [sh, sm] = start_time.split(':').map(Number);
      const [eh, em] = end_time.split(':').map(Number);
      const hours = (eh * 60 + em - (sh * 60 + sm)) / 60;
      if (hours > PERMISSION_MAX_HOURS) throw new AppError(400, PERMISSION_MAX_HOURS_MESSAGE);
    }
  }

  try {
    const result = await pool.query(
      `INSERT INTO leave_requests
         (company_id, employee_id, category, type, start_date, end_date, start_time, end_time,
          reason, permission_reason, notice_received_by, attachment_base64, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
       RETURNING id, employee_id, category, type, start_date, end_date, start_time, end_time,
                 reason, permission_reason, notice_received_by, status, created_at`,
      [
        companyId,
        employee_id,
        category,
        finalType,
        start_date,
        end_date ?? null,
        start_time ?? null,
        end_time ?? null,
        reason ?? null,
        finalPermissionReason,
        finalNoticeReceivedBy,
        attachment_base64 ?? null,
      ]
    );
    const leaveRequest = result.rows[0];
    await logAudit({ companyId, userId: req.auth!.userId, action: 'leave_request_created', entityType: 'leave_requests', entityId: leaveRequest.id, req });

    const employee = await pool.query('SELECT name FROM employees WHERE id = $1', [employee_id]);
    notifyRoles({
      companyId,
      roles: ['admin', 'manager'],
      type: 'leave_request_created',
      title: `New request — ${employee.rows[0]?.name ?? ''}`,
      body: category === 'leave' ? `${finalType} starting ${start_date}` : `Absence permission — ${finalPermissionReason} on ${start_date}`,
      link: '/leave-requests',
    });

    res.status(201).json({ success: true, leave_request: leaveRequest });
  } catch (err) {
    if (isForeignKeyViolation(err)) throw new AppError(400, 'employee_id does not exist');
    throw err;
  }
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, status, type, category } = req.query;

  const params: unknown[] = [companyId];
  let where = 'lr.company_id = $1';

  // Same finding #2 fix: list() had no per-row ownership filter — any employee could
  // pull every other employee's leave/absence-permission requests (type, reason,
  // attachment) for the whole company. Force the filter for role='employee', ignore
  // any employee_id they pass in the query. Extended 2026-08-26 (hrScope.ts) with a
  // department-wide filter for a non-HR manager, same override-can-only-narrow
  // pattern as attendance.controller.ts's list().
  const scope = await getHrScope(companyId, req.auth!.userId, req.auth!.role);
  if (scope.level === 'self') {
    const ownEmployeeId = await getOwnEmployeeId(req.auth!.userId, companyId);
    params.push(ownEmployeeId);
    where += ` AND lr.employee_id = $${params.length}`;
  } else {
    if (scope.level === 'department') {
      params.push(scope.departmentIds);
      where += ` AND e.department_id = ANY($${params.length}::uuid[])`;
    }
    if (typeof employee_id === 'string') {
      params.push(employee_id);
      where += ` AND lr.employee_id = $${params.length}`;
    }
  }
  if (typeof status === 'string') {
    params.push(status);
    where += ` AND lr.status = $${params.length}`;
  }
  if (typeof type === 'string') {
    params.push(type);
    where += ` AND lr.type = $${params.length}`;
  }
  if (typeof category === 'string') {
    params.push(category);
    where += ` AND lr.category = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT lr.id, lr.employee_id, e.name AS employee_name, lr.category, lr.type, lr.start_date, lr.end_date,
            lr.start_time, lr.end_time, lr.reason, lr.permission_reason, lr.notice_received_by,
            lr.attachment_base64, lr.status, lr.manager_note,
            lr.reviewed_by, lr.reviewed_at, lr.created_at
     FROM leave_requests lr
     JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id
     WHERE ${where} ORDER BY lr.created_at DESC`,
    params
  );
  res.status(200).json({ success: true, leave_requests: result.rows });
});

// Manager-only full edit — covers the quick "approve/reject" case (send just
// { status }) and the "edit any request" case from the edit modal (employee,
// category/type/reason fields, dates/times, status, manager_note all optional/partial).
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const {
    employee_id,
    category,
    type,
    start_date,
    end_date,
    start_time,
    end_time,
    reason,
    permission_reason,
    notice_received_by,
    attachment_base64,
    status,
    manager_note,
  } = req.body ?? {};

  {
    const existing = await pool.query('SELECT employee_id FROM leave_requests WHERE id = $1 AND company_id = $2', [id, companyId]);
    if (!existing.rows[0]) throw new AppError(404, 'Leave request not found');
    const scope = await getHrScope(companyId, req.auth!.userId, req.auth!.role);
    if (!(await isEmployeeInHrScope(companyId, scope, existing.rows[0].employee_id))) {
      throw new AppError(404, 'Leave request not found');
    }
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (employee_id !== undefined) {
    if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id must be a string');
    sets.push(`employee_id = $${i++}`);
    values.push(employee_id);
  }
  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) throw new AppError(400, `category must be one of ${CATEGORIES.join(', ')}`);
    sets.push(`category = $${i++}`);
    values.push(category);
  }
  if (type !== undefined) {
    if (!TYPES_ALL.includes(type)) throw new AppError(400, `type must be one of ${TYPES_ALL.join(', ')}`);
    sets.push(`type = $${i++}`);
    values.push(type);
  }
  if (permission_reason !== undefined) {
    if (permission_reason !== null && !PERMISSION_REASONS.includes(permission_reason)) {
      throw new AppError(400, `permission_reason must be one of ${PERMISSION_REASONS.join(', ')}`);
    }
    sets.push(`permission_reason = $${i++}`);
    values.push(permission_reason);
  }
  if (notice_received_by !== undefined) {
    if (notice_received_by !== null && !NOTICE_RECEIVED_BY.includes(notice_received_by)) {
      throw new AppError(400, `notice_received_by must be one of ${NOTICE_RECEIVED_BY.join(', ')}`);
    }
    sets.push(`notice_received_by = $${i++}`);
    values.push(notice_received_by);
  }
  if (start_date !== undefined) {
    if (typeof start_date !== 'string') throw new AppError(400, 'start_date must be a string');
    sets.push(`start_date = $${i++}`);
    values.push(start_date);
  }
  if (end_date !== undefined) {
    sets.push(`end_date = $${i++}`);
    values.push(end_date);
  }
  if (start_time !== undefined) {
    sets.push(`start_time = $${i++}`);
    values.push(start_time);
  }
  if (end_time !== undefined) {
    sets.push(`end_time = $${i++}`);
    values.push(end_time);
  }
  if (reason !== undefined) {
    sets.push(`reason = $${i++}`);
    values.push(reason);
  }
  if (attachment_base64 !== undefined) {
    sets.push(`attachment_base64 = $${i++}`);
    values.push(attachment_base64);
  }
  if (manager_note !== undefined) {
    sets.push(`manager_note = $${i++}`);
    values.push(manager_note);
  }
  if (status !== undefined) {
    if (!['pending', 'approved', 'rejected'].includes(status)) throw new AppError(400, 'status must be pending, approved, or rejected');
    sets.push(`status = $${i++}`);
    values.push(status);
    sets.push(`reviewed_by = $${i++}`);
    values.push(req.auth!.userId);
    sets.push(`reviewed_at = NOW()`);
  }

  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push(`updated_at = NOW()`);
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE leave_requests SET ${sets.join(', ')}
     WHERE id = $${i++} AND company_id = $${i++}
     RETURNING id, employee_id, category, type, start_date, end_date, start_time, end_time,
               reason, permission_reason, notice_received_by, status, manager_note, reviewed_by, reviewed_at`,
    values
  );
  const leaveRequest = result.rows[0];
  if (!leaveRequest) throw new AppError(404, 'Leave request not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'leave_request_updated', entityType: 'leave_requests', entityId: id as string, req });

  res.status(200).json({ success: true, leave_request: leaveRequest });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  {
    const existing = await pool.query('SELECT employee_id FROM leave_requests WHERE id = $1 AND company_id = $2', [id, companyId]);
    if (!existing.rows[0]) throw new AppError(404, 'Leave request not found');
    const scope = await getHrScope(companyId, req.auth!.userId, req.auth!.role);
    if (!(await isEmployeeInHrScope(companyId, scope, existing.rows[0].employee_id))) {
      throw new AppError(404, 'Leave request not found');
    }
  }

  const result = await pool.query('DELETE FROM leave_requests WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (result.rows.length === 0) throw new AppError(404, 'Leave request not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'leave_request_deleted', entityType: 'leave_requests', entityId: id as string, req });

  res.status(200).json({ success: true });
});

// Approved leave/absence-permission that overlaps the given month — feeds the colored annual calendar.
export const calendar = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const year = parseInt(String(req.query.year ?? new Date().getFullYear()), 10);
  const month = parseInt(String(req.query.month ?? new Date().getMonth() + 1), 10);
  if (!year || !month || month < 1 || month > 12) throw new AppError(400, 'year and month must be valid');

  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  const params: unknown[] = [companyId, monthStart, nextMonth];
  let where = "lr.company_id = $1 AND lr.status = 'approved' AND lr.start_date < $3 AND COALESCE(lr.end_date, lr.start_date) >= $2";

  // Product decision (confirmed with the user): the annual calendar is private per
  // employee, not a shared company-wide "who's off" view — same ownership scope as
  // create()/list() above (audit finding #2).
  if (req.auth!.role === 'employee') {
    const ownEmployeeId = await getOwnEmployeeId(req.auth!.userId, companyId);
    params.push(ownEmployeeId);
    where += ` AND lr.employee_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT lr.id, lr.employee_id, e.name AS employee_name, lr.category, lr.type, lr.permission_reason,
            lr.start_date, lr.end_date, lr.start_time, lr.end_time
     FROM leave_requests lr
     JOIN employees e ON e.id = lr.employee_id AND e.company_id = lr.company_id
     WHERE ${where}
     ORDER BY lr.start_date ASC`,
    params
  );
  res.status(200).json({ success: true, year, month, leave_requests: result.rows });
});
