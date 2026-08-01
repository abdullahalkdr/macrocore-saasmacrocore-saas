import { Router } from 'express';
import { list, create, remove } from '../controllers/customFields.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', requireRole('admin', 'manager'), create);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
