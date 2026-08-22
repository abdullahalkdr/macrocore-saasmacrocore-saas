import { Router } from 'express';
import {
  listForms,
  createForm,
  updateForm,
  removeForm,
  listQuestions,
  createQuestion,
  updateQuestion,
  removeQuestion,
} from '../controllers/appraisals.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth, requireRole('admin', 'manager'));
router.get('/forms', listForms);
router.post('/forms', createForm);
router.patch('/forms/:id', updateForm);
router.delete('/forms/:id', removeForm);
router.get('/forms/:formId/questions', listQuestions);
router.post('/forms/:formId/questions', createQuestion);
router.patch('/questions/:id', updateQuestion);
router.delete('/questions/:id', removeQuestion);

export default router;
