import { Router } from 'express';
import { open, close, getOne, list } from '../controllers/shifts.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.post('/', open);
router.get('/', list);
router.patch('/:id', close);
router.get('/:id', getOne);

export default router;
