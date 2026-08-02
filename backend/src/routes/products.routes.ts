import { Router } from 'express';
import { list, create, getOne, getCost, costPreview, update, remove } from '../controllers/products.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/cost-preview', requireRole('admin', 'manager'), costPreview);
router.post('/', requireRole('admin', 'manager'), create);
router.get('/:id/cost', getCost);
router.get('/:id', getOne);
router.patch('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
