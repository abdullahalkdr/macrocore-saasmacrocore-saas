import { Router } from 'express';
import { list, create, getOne, getCost, costPreview, update, remove } from '../controllers/products.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { requireRoleOrPermission } from '../middleware/requirePermission';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/cost-preview', requireRole('admin', 'manager'), costPreview);
router.post('/', requireRole('admin', 'manager'), create);
// Previously open to any authenticated user — raw cost + profit margin is sensitive
// financial data an 'employee' role shouldn't see by default (the frontend already only
// let admin/manager reach the Products page, but the API itself had no matching guard).
// Restricted to admin/manager, with 'view_profit_margins' as the named exception.
router.get('/:id/cost', requireRoleOrPermission(['admin', 'manager'], 'view_profit_margins'), getCost);
router.get('/:id', getOne);
router.patch('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
