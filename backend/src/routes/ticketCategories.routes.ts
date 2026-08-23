import { Router } from 'express';
import { list, create, update, remove } from '../controllers/ticketCategories.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
// Any authenticated role can read categories (an employee needs the list to
// file a ticket) — only admin/manager can define/change/remove them, same
// split documentTemplates.routes.ts uses for its own company-config resource.
router.get('/', list);
router.post('/', requireRole('admin', 'manager'), create);
router.put('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
