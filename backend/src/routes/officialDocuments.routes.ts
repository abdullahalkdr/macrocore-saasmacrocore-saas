import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import * as controller from '../controllers/officialDocuments.controller';

const router = Router();

router.use(requireAuth);
router.get('/', controller.list);
router.get('/next-reference', controller.peekNextReference);
router.get('/:id', controller.getOne);
router.post('/', requireRole('admin', 'manager'), controller.create);
router.patch('/:id', requireRole('admin', 'manager'), controller.update);
router.delete('/:id', requireRole('admin', 'manager'), controller.remove);

export default router;
