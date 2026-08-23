import { Router } from 'express';
import { list, create, update, remove } from '../controllers/departments.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
// Any authenticated role can read the department list (shows up in the
// support ticket assignee picker, and in an employee's own profile) — only
// admin/manager can define/change/remove departments, same split
// serviceCategories.routes.ts uses for its own company-config resource.
router.get('/', list);
router.post('/', requireRole('admin', 'manager'), create);
router.put('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
