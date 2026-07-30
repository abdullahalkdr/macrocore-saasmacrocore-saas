import { Router } from 'express';
import { clockIn, clockOut, list, upsertManual } from '../controllers/attendance.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/clock-in', clockIn);
router.post('/clock-out', clockOut);
router.post('/manual', requireRole('admin', 'manager'), upsertManual);

export default router;
