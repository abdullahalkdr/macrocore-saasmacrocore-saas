import { Router } from 'express';
import { list, create, update, remove } from '../controllers/expenses.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { requireRoleOrPermission } from '../middleware/requirePermission';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', create);
router.patch('/:id', requireRoleOrPermission(['admin', 'manager'], 'edit_expenses'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
