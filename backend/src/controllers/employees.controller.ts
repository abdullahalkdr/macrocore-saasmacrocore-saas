import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { isForeignKeyViolation } from '../utils/dbErrors';
import { getHrScope } from '../utils/hrScope';

interface Certificate {
  name: string;
  name_en?: string;
  issuer?: string;
  issued_date?: string;
  file_base64?: string;
}

interface Allowance {
  label: string;
  amount: number;
}

const SELECT_COLUMNS = `id, name, email, phone, job_role, job_role_id, salary_monthly, start_date, status,
  photo_base64, civil_id, birth_date, weight_kg, prior_experience, certificates, wage_type, hourly_rate,
  nationality, civil_id_expiry, residency_number, residency_expiry, passport_number, passport_expiry,
  bank_iban, emergency_contact_name, emergency_contact_phone, location_id, allowances, shift_start_time,
  late_grace_minutes, department_id, manager_id, created_at`;

// Same columns, prefixed with e. — used by list()/getOne() which LEFT JOIN locations
// (unprefixed column names would be ambiguous once joined, since locations also has id/name).
const SELECT_COLUMNS_JOINED = SELECT_COLUMNS.split(',')
  .map((c) => `e.${c.trim()}`)
  .join(', ');

const WAGE_TYPES = ['monthly', 'hourly'];
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

function validateCertificates(certificates: unknown): Certificate[] {
  if (certificates === undefined) return [];
  if (!Array.isArray(certificates)) throw new AppError(400, 'certificates must be an array');
  for (const c of certificates) {
    if (typeof c.name !== 'string' || c.name.trim().length < 1) throw new AppError(400, 'each certificate needs a name');
  }
  return certificates;
}

// Itemized monthly allowances (housing, transport, etc.) — summed automatically into
// the base salary at payroll generation time (see payroll.controller.ts's create()).
function validateAllowances(allowances: unknown): Allowance[] {
  if (allowances === undefined) return [];
  if (!Array.isArray(allowances)) throw new AppError(400, 'allowances must be an array');
  for (const a of allowances) {
    if (typeof a?.label !== 'string' || a.label.trim().length < 1) throw new AppError(400, 'each allowance needs a label');
    if (typeof a?.amount !== 'number' || a.amount < 0) throw new AppError(400, 'each allowance needs a non-negative amount');
  }
  return allowances;
}

// Computed in JS rather than SQL (e.g. AGE()/EXTRACT) — keeps the query portable and
// avoids a day-boundary/timezone mismatch between the DB server and this app server.
function withAge<T extends { birth_date: string | null }>(row: T): T & { age: number | null } {
  if (!row.birth_date) return { ...row, age: null };
  const birth = new Date(row.birth_date);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const hasHadBirthdayThisYear = now.getMonth() > birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() >= birth.getDate());
  if (!hasHadBirthdayThisYear) age -= 1;
  return { ...row, age };
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const now = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.ceil((Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / msPerDay);
}

// Same expiry-countdown treatment already used for raw material batches and
// company files — civil ID / residency / passport are the compliance-critical
// dates for an expat-heavy kiosk workforce in Kuwait.
function withExpiries<T extends { civil_id_expiry: string | null; residency_expiry: string | null; passport_expiry: string | null }>(
  row: T
): T & { days_until_civil_id_expiry: number | null; days_until_residency_expiry: number | null; days_until_passport_expiry: number | null } {
  return {
    ...row,
    days_until_civil_id_expiry: daysUntil(row.civil_id_expiry),
    days_until_residency_expiry: daysUntil(row.residency_expiry),
    days_until_passport_expiry: daysUntil(row.passport_expiry),
  };
}

// Department-scoped since the 2026-08-26 HR-visibility fix (hrScope.ts) — a
// non-HR manager only sees their own department (+ descendants), a plain
// employee only sees themself. admin and HR-department members are
// unrestricted, same as this endpoint's original company-wide behavior.
//
// Write-side guard (create/update/remove) — TIGHTENED 2026-08-29 to require
// FULL scope only (admin, or a genuine HR-department member), never
// 'department' scope. Originally (2026-08-27 fix) 'department' scope was
// allowed to write within its own subtree, mirroring the read-side check —
// but the same day the manager_id-based department-scope path was added
// (see hrScope.ts / claude/manager-scope-department-based-decision.md),
// live testing surfaced the real-world gap: a department's formal Manager
// (via departments.manager_id, independent of their own department/role)
// could add/edit/delete employee master records — salary, bank IBAN, civil
// ID, hire/fire — in departments they merely head for org-chart/approval
// purposes, with no actual HR function. Standard HRIS practice (Workday,
// SuccessFactors, BambooHR, etc.) keeps this split: a line/department
// manager views their team and handles day-to-day operational actions
// (attendance, leave approval, performance reviews — see
// attendance.controller.ts / leaveRequests.controller.ts /
// performanceScores.controller.ts, all still 'department'-scope on write),
// but the employee master record itself — the thing this controller
// owns — is HR/admin administrative territory. So: 'full' scope can create/
// update/remove any employee, including department_id = null. Anyone else
// ('department' or 'self' scope) gets zero write access here, regardless of
// which department is involved — read-only via list()/getOne(), unchanged.
async function assertFullHrScope(scope: Awaited<ReturnType<typeof getHrScope>>): Promise<void> {
  if (scope.level === 'full') return;
  throw new AppError(403, 'Only HR or an administrator can add, edit, or remove employee records.');
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const scope = await getHrScope(companyId, req.auth!.userId, req.auth!.role);

  const params: unknown[] = [companyId];
  let where = 'e.company_id = $1';
  if (scope.level === 'self') {
    params.push(scope.employeeId);
    where += ` AND e.id = $${params.length}`;
  } else if (scope.level === 'department') {
    params.push(scope.departmentIds);
    where += ` AND e.department_id = ANY($${params.length}::uuid[])`;
  } else if (scope.level === 'direct_reports') {
    params.push(scope.employeeIds);
    where += ` AND e.id = ANY($${params.length}::uuid[])`;
  }

  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS_JOINED}, l.name AS location_name, d.name AS department_name, d.name_en AS department_name_en
     FROM employees e
     LEFT JOIN locations l ON l.id = e.location_id AND l.company_id = e.company_id
     LEFT JOIN departments d ON d.id = e.department_id AND d.company_id = e.company_id
     WHERE ${where} ORDER BY e.created_at DESC`,
    params
  );
  res.status(200).json({ success: true, employees: result.rows.map((r) => withExpiries(withAge(r))) });
});

// Same department scoping as list() above, applied to the single-record
// fetch too — otherwise a manager could reach another department's employee
// directly by id (e.g. an id seen in a company-wide picker elsewhere) even
// though list() no longer returns it. Not found (not forbidden) on a
// scope miss, consistent with how this endpoint already reports a
// wrong/deleted id.
export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS_JOINED}, l.name AS location_name, d.name AS department_name, d.name_en AS department_name_en
     FROM employees e
     LEFT JOIN locations l ON l.id = e.location_id AND l.company_id = e.company_id
     LEFT JOIN departments d ON d.id = e.department_id AND d.company_id = e.company_id
     WHERE e.id = $1 AND e.company_id = $2`,
    [id, companyId]
  );
  const employee = result.rows[0];
  if (!employee) throw new AppError(404, 'Employee not found');

  const scope = await getHrScope(companyId, req.auth!.userId, req.auth!.role);
  if (scope.level === 'self' && employee.id !== scope.employeeId) throw new AppError(404, 'Employee not found');
  if (scope.level === 'department' && !scope.departmentIds.includes(employee.department_id)) throw new AppError(404, 'Employee not found');
  if (scope.level === 'direct_reports' && !scope.employeeIds.includes(employee.id)) throw new AppError(404, 'Employee not found');

  res.status(200).json({ success: true, employee: withExpiries(withAge(employee)) });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const {
    name,
    email,
    phone,
    job_role,
    job_role_id,
    salary_monthly,
    start_date,
    photo_base64,
    civil_id,
    birth_date,
    weight_kg,
    prior_experience,
    certificates,
    wage_type,
    hourly_rate,
    nationality,
    civil_id_expiry,
    residency_number,
    residency_expiry,
    passport_number,
    passport_expiry,
    bank_iban,
    emergency_contact_name,
    emergency_contact_phone,
    location_id,
    department_id,
    manager_id,
    allowances,
    shift_start_time,
    late_grace_minutes,
  } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (wage_type !== undefined && !WAGE_TYPES.includes(wage_type)) {
    throw new AppError(400, `wage_type must be one of ${WAGE_TYPES.join(', ')}`);
  }
  if (shift_start_time !== undefined && shift_start_time !== null && !TIME_RE.test(shift_start_time)) {
    throw new AppError(400, 'shift_start_time must be HH:MM');
  }
  if (late_grace_minutes !== undefined && late_grace_minutes !== null && (typeof late_grace_minutes !== 'number' || late_grace_minutes < 0)) {
    throw new AppError(400, 'late_grace_minutes must be a non-negative number');
  }
  if (location_id) {
    const loc = await pool.query('SELECT id FROM locations WHERE id = $1 AND company_id = $2', [location_id, companyId]);
    if (loc.rows.length === 0) throw new AppError(400, 'location_id not found');
  }
  // MIGRATION_048 — same cross-tenant-validation shape as location_id above.
  if (department_id) {
    const dept = await pool.query('SELECT id FROM departments WHERE id = $1 AND company_id = $2', [department_id, companyId]);
    if (dept.rows.length === 0) throw new AppError(400, 'department_id not found');
  }
  // MIGRATION_073 — "Direct Manager" (see hrScope.ts / manager-scope-based-
  // decision.md). Same cross-tenant-validation shape as department_id/
  // location_id above; the self-reference case can't occur on create()
  // since the new employee's id doesn't exist yet.
  if (manager_id) {
    const mgr = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [manager_id, companyId]);
    if (mgr.rows.length === 0) throw new AppError(400, 'manager_id not found');
  }
  {
    const scope = await getHrScope(companyId, req.auth!.userId, req.auth!.role);
    await assertFullHrScope(scope);
  }
  // MIGRATION_054 — job_role_id is the FK link EmployeesPage.tsx's dropdown resolves to
  // (its "Other" free-text fallback simply omits this and only sends job_role text).
  // Drives job-role-level permission grants (job_role_permissions), so it's validated
  // the same tenant-scoped way as department_id/location_id above.
  if (job_role_id) {
    const role = await pool.query('SELECT id FROM job_roles WHERE id = $1 AND company_id = $2', [job_role_id, companyId]);
    if (role.rows.length === 0) throw new AppError(400, 'job_role_id not found');
  }
  const certList = validateCertificates(certificates);
  const allowanceList = validateAllowances(allowances);

  const result = await pool.query(
    `INSERT INTO employees (company_id, name, email, phone, job_role, job_role_id, salary_monthly, start_date,
       photo_base64, civil_id, birth_date, weight_kg, prior_experience, certificates, wage_type, hourly_rate,
       nationality, civil_id_expiry, residency_number, residency_expiry, passport_number, passport_expiry,
       bank_iban, emergency_contact_name, emergency_contact_phone, location_id, department_id, manager_id,
       allowances, shift_start_time, late_grace_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22,
       $23, $24, $25, $26, $27, $28, $29::jsonb, $30, $31)
     RETURNING ${SELECT_COLUMNS}`,
    [
      companyId,
      name.trim(),
      email ?? null,
      phone ?? null,
      job_role ?? null,
      job_role_id ?? null,
      salary_monthly ?? null,
      start_date ?? null,
      photo_base64 ?? null,
      civil_id ?? null,
      birth_date ?? null,
      weight_kg ?? null,
      prior_experience ?? null,
      JSON.stringify(certList),
      wage_type ?? 'monthly',
      hourly_rate ?? null,
      nationality ?? null,
      civil_id_expiry ?? null,
      residency_number ?? null,
      residency_expiry ?? null,
      passport_number ?? null,
      passport_expiry ?? null,
      bank_iban ?? null,
      emergency_contact_name ?? null,
      emergency_contact_phone ?? null,
      location_id ?? null,
      department_id ?? null,
      manager_id ?? null,
      JSON.stringify(allowanceList),
      shift_start_time ?? null,
      late_grace_minutes ?? null,
    ]
  );
  const employee = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'employee_created', entityType: 'employees', entityId: employee.id, req });

  res.status(201).json({ success: true, employee: withExpiries(withAge(employee)) });
});

// Every field optional — only the ones provided get updated. Lets the Employees page
// save a single field (e.g. just adding a certificate) without resending everything.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const {
    name,
    email,
    phone,
    job_role,
    job_role_id,
    salary_monthly,
    start_date,
    status,
    photo_base64,
    civil_id,
    birth_date,
    weight_kg,
    prior_experience,
    certificates,
    wage_type,
    hourly_rate,
    nationality,
    civil_id_expiry,
    residency_number,
    residency_expiry,
    passport_number,
    passport_expiry,
    bank_iban,
    emergency_contact_name,
    emergency_contact_phone,
    location_id,
    department_id,
    manager_id,
    allowances,
    shift_start_time,
    late_grace_minutes,
  } = req.body ?? {};

  {
    const existingDept = await pool.query('SELECT department_id FROM employees WHERE id = $1 AND company_id = $2', [id, companyId]);
    if (!existingDept.rows[0]) throw new AppError(404, 'Employee not found');
    const scope = await getHrScope(companyId, req.auth!.userId, req.auth!.role);
    await assertFullHrScope(scope);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  const setField = (column: string, value: unknown, cast?: string) => {
    sets.push(`${column} = $${i++}${cast ? `::${cast}` : ''}`);
    values.push(value);
  };

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name must be a non-empty string');
    setField('name', name.trim());
  }
  if (email !== undefined) setField('email', email || null);
  if (phone !== undefined) setField('phone', phone || null);
  if (job_role !== undefined) setField('job_role', job_role || null);
  if (job_role_id !== undefined) {
    if (job_role_id) {
      const role = await pool.query('SELECT id FROM job_roles WHERE id = $1 AND company_id = $2', [job_role_id, companyId]);
      if (role.rows.length === 0) throw new AppError(400, 'job_role_id not found');
    }
    setField('job_role_id', job_role_id || null);
  }
  if (salary_monthly !== undefined) {
    if (salary_monthly !== null && typeof salary_monthly !== 'number') throw new AppError(400, 'salary_monthly must be a number');
    setField('salary_monthly', salary_monthly);
  }
  if (start_date !== undefined) setField('start_date', start_date || null);
  if (status !== undefined) {
    if (!['active', 'inactive'].includes(status)) throw new AppError(400, 'status must be active or inactive');
    setField('status', status);
  }
  if (photo_base64 !== undefined) setField('photo_base64', photo_base64 || null);
  if (civil_id !== undefined) setField('civil_id', civil_id || null);
  if (birth_date !== undefined) setField('birth_date', birth_date || null);
  if (weight_kg !== undefined) {
    if (weight_kg !== null && typeof weight_kg !== 'number') throw new AppError(400, 'weight_kg must be a number');
    setField('weight_kg', weight_kg);
  }
  if (prior_experience !== undefined) setField('prior_experience', prior_experience || null);
  if (certificates !== undefined) setField('certificates', JSON.stringify(validateCertificates(certificates)), 'jsonb');
  if (wage_type !== undefined) {
    if (!WAGE_TYPES.includes(wage_type)) throw new AppError(400, `wage_type must be one of ${WAGE_TYPES.join(', ')}`);
    setField('wage_type', wage_type);
  }
  if (hourly_rate !== undefined) {
    if (hourly_rate !== null && typeof hourly_rate !== 'number') throw new AppError(400, 'hourly_rate must be a number');
    setField('hourly_rate', hourly_rate);
  }
  if (nationality !== undefined) setField('nationality', nationality || null);
  if (civil_id_expiry !== undefined) setField('civil_id_expiry', civil_id_expiry || null);
  if (residency_number !== undefined) setField('residency_number', residency_number || null);
  if (residency_expiry !== undefined) setField('residency_expiry', residency_expiry || null);
  if (passport_number !== undefined) setField('passport_number', passport_number || null);
  if (passport_expiry !== undefined) setField('passport_expiry', passport_expiry || null);
  if (bank_iban !== undefined) setField('bank_iban', bank_iban || null);
  if (emergency_contact_name !== undefined) setField('emergency_contact_name', emergency_contact_name || null);
  if (emergency_contact_phone !== undefined) setField('emergency_contact_phone', emergency_contact_phone || null);
  if (location_id !== undefined) {
    if (location_id) {
      const loc = await pool.query('SELECT id FROM locations WHERE id = $1 AND company_id = $2', [location_id, companyId]);
      if (loc.rows.length === 0) throw new AppError(400, 'location_id not found');
    }
    setField('location_id', location_id || null);
  }
  if (department_id !== undefined) {
    if (department_id) {
      const dept = await pool.query('SELECT id FROM departments WHERE id = $1 AND company_id = $2', [department_id, companyId]);
      if (dept.rows.length === 0) throw new AppError(400, 'department_id not found');
    }
    setField('department_id', department_id || null);
  }
  // MIGRATION_073 — "Direct Manager". Same cross-tenant shape as department_id
  // above, plus a self-reference guard (the DB CHECK constraint would also
  // catch this, but failing here gives a clean 400 instead of a raw
  // constraint-violation error).
  if (manager_id !== undefined) {
    if (manager_id) {
      if (manager_id === id) throw new AppError(400, 'An employee cannot be their own direct manager');
      const mgr = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [manager_id, companyId]);
      if (mgr.rows.length === 0) throw new AppError(400, 'manager_id not found');
    }
    setField('manager_id', manager_id || null);
  }
  if (allowances !== undefined) setField('allowances', JSON.stringify(validateAllowances(allowances)), 'jsonb');
  if (shift_start_time !== undefined) {
    if (shift_start_time !== null && !TIME_RE.test(shift_start_time)) throw new AppError(400, 'shift_start_time must be HH:MM');
    setField('shift_start_time', shift_start_time || null);
  }
  if (late_grace_minutes !== undefined) {
    if (late_grace_minutes !== null && (typeof late_grace_minutes !== 'number' || late_grace_minutes < 0)) {
      throw new AppError(400, 'late_grace_minutes must be a non-negative number');
    }
    setField('late_grace_minutes', late_grace_minutes);
  }

  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE employees SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i}
     RETURNING ${SELECT_COLUMNS}`,
    values
  );
  const employee = result.rows[0];
  if (!employee) throw new AppError(404, 'Employee not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'employee_updated', entityType: 'employees', entityId: id as string, req });

  res.status(200).json({ success: true, employee: withExpiries(withAge(employee)) });
});

// Admin/manager only (see routes). Blocked by a FK violation if the employee has
// shifts or payroll records (both plain REFERENCES, no cascade) — attendance_records
// and leave_requests do cascade and vanish with them. Use `status: 'inactive'` via
// update() instead once an employee has any work history.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const before = await pool.query(`SELECT ${SELECT_COLUMNS} FROM employees WHERE id = $1 AND company_id = $2`, [id, companyId]);
  const oldEmployee = before.rows[0] ?? null;

  if (oldEmployee) {
    const scope = await getHrScope(companyId, req.auth!.userId, req.auth!.role);
    await assertFullHrScope(scope);
  }

  try {
    const result = await pool.query('DELETE FROM employees WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
    if (result.rows.length === 0) throw new AppError(404, 'Employee not found');
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new AppError(409, 'This employee has shifts or payroll history and cannot be deleted — set them to inactive instead');
    }
    throw err;
  }

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'employee_deleted',
    entityType: 'employees',
    entityId: id as string,
    req,
    oldValues: oldEmployee,
    newValues: null,
  });

  res.status(200).json({ success: true });
});
