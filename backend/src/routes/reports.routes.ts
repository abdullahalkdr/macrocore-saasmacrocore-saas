import { Router } from 'express';
import { daily, monthly, summary } from '../controllers/reports.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.get('/daily', daily);
router.get('/monthly', monthly);
router.get('/summary', summary);

export default router;
