import { Router } from 'express';
import { clockIn, clockOut, list, upsertManual } from '../controllers/attendance.controller';
import { requireAuth } from '../middleware/auth';
import { requireRoleOrPermission } from '../middleware/requirePermission';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/clock-in', clockIn);
router.post('/clock-out', clockOut);
router.post('/manual', requireRoleOrPermission(['admin', 'manager'], 'manual_attendance'), upsertManual);

export default router;
