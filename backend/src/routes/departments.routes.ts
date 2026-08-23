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
