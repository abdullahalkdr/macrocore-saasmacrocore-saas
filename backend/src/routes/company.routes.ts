import { Router } from 'express';
import { getMe, updateMe, deleteMe } from '../controllers/company.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/me', getMe);
// Settings (name, fixed costs, commission defaults) are manager-territory —
// an employee could previously PATCH this with no role check at all.
router.patch('/me', requireRole('admin', 'manager'), updateMe);
router.delete('/me', requireRole('admin'), deleteMe);

export default router;
