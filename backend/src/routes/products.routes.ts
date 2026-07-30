import { Router } from 'express';
import { list, create, getOne, getCost } from '../controllers/products.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', requireRole('admin', 'manager'), create);
router.get('/:id/cost', getCost);
router.get('/:id', getOne);

export default router;
