import { Router } from 'express';
import { list } from '../controllers/auditLog.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', requireRole('admin', 'manager'), list);

export default router;
