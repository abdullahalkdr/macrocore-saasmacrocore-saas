import { Router } from 'express';
import { listScores, upsertScore, finalizeScore } from '../controllers/performanceScores.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/', listScores);
router.post('/', requireRole('admin', 'manager'), upsertScore);
router.post('/:id/finalize', requireRole('admin', 'manager'), finalizeScore);

export default router;
