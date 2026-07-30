import { Router } from 'express';
import { list, create } from '../controllers/wasteRecords.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', create);

export default router;
