import { Router } from 'express';
import {
  list,
  create,
  update,
  remove,
  listRoles,
  createRole,
  updateRole,
  removeRole,
  applyTemplate,
} from '../controllers/departments.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
// Any authenticated role can read the department list (shows up in the
// support ticket assignee picker, the Employee modal's Job Role picker, and
// in an employee's own profile) — only admin/manager can define/change/
// remove departments and their job roles, same split serviceCategories.routes.ts
// uses for its own company-config resource.
router.get('/', list);
// MIGRATION_069 for IT, generalized 2026-08-26 to all 6 default department
// templates — admin-only, replaces the named department's tree with the
// full researched org template for that key (IT/HR/FINANCE/MARKETING/
// LEGAL/OPERATIONS). Placed before the '/:id' routes for readability; the
// literal 'template' segment never collides with a real department id.
router.post('/template/:key/apply', requireRole('admin'), applyTemplate);
router.post('/', requireRole('admin', 'manager'), create);
router.put('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

// MIGRATION_049 — job_roles nested under departments (mirrors okr.routes.ts's
// objectives/key-results nesting: list/create take the parent id from the
// route, update/remove address the role directly by its own id).
router.get('/:id/roles', listRoles);
router.post('/:id/roles', requireRole('admin', 'manager'), createRole);
router.patch('/roles/:id', requireRole('admin', 'manager'), updateRole);
router.delete('/roles/:id', requireRole('admin', 'manager'), removeRole);

export default router;
