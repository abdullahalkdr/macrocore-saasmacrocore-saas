import { Router } from 'express';
import {
  listCycles,
  createCycle,
  updateCycle,
  createRequests,
  listRequests,
  listMyRequests,
  submitAnswers,
  getResults,
} from '../controllers/feedback.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
router.get('/cycles', requireRole('admin', 'manager'), listCycles);
router.post('/cycles', requireRole('admin', 'manager'), createCycle);
router.patch('/cycles/:id', requireRole('admin', 'manager'), updateCycle);
router.post('/cycles/:id/requests', requireRole('admin', 'manager'), createRequests);
router.get('/requests', requireRole('admin', 'manager'), listRequests);
router.get('/requests/mine', listMyRequests);
router.post('/requests/:id/answers', submitAnswers);
router.get('/results/:subjectEmployeeId', getResults);

export default router;
