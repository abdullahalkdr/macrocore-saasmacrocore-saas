import { Router } from 'express';
import { list, upsert, remove } from '../controllers/slaPolicies.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth, requireRole('admin', 'manager'));
router.get('/', list);
router.put('/:priority', upsert);
router.delete('/:priority', remove);

export default router;
