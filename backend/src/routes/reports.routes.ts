import { Router } from 'express';
import { daily, monthly, range, summary } from '../controllers/reports.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.get('/daily', daily);
router.get('/monthly', monthly);
router.get('/range', range);
router.get('/summary', summary);

export default router;
