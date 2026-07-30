import { Router } from 'express';
import { create, list, remove } from '../controllers/sales.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.post('/', create);
router.get('/', list);
router.delete('/:id', remove);

export default router;
