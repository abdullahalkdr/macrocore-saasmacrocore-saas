import { Router } from 'express';
import { pull, push } from '../controllers/sync.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.post('/pull', pull);
router.post('/push', push);

export default router;
