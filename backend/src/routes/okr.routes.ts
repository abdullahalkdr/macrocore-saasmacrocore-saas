import { Router } from 'express';
import {
  listObjectives,
  createObjective,
  updateObjective,
  removeObjective,
  createKeyResult,
  updateKeyResult,
  removeKeyResult,
} from '../controllers/okr.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/objectives', listObjectives);
router.post('/objectives', createObjective);
router.patch('/objectives/:id', updateObjective);
router.delete('/objectives/:id', requireRole('admin', 'manager'), removeObjective);
router.post('/objectives/:id/key-results', createKeyResult);
router.patch('/key-results/:id', updateKeyResult);
router.delete('/key-results/:id', requireRole('admin', 'manager'), removeKeyResult);

export default router;
