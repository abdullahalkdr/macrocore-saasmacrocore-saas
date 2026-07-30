import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import * as controller from '../controllers/stockTransfers.controller';

const router = Router();

router.use(requireAuth);
router.post('/', requireRole('admin', 'manager'), controller.create);
router.get('/', controller.list);

export default router;
