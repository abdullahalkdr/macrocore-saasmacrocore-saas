import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import * as controller from '../controllers/rawMaterialBatches.controller';

const router = Router();

// All batch operations: auth required, manager+ can modify (create/update/delete), anyone can read
router.post('/', requireAuth, requireRole('admin', 'manager'), controller.create);
router.get('/', requireAuth, controller.list);
router.get('/expiring/list', requireAuth, controller.getExpiring);
router.get('/:id', requireAuth, controller.getById);
router.patch('/:id', requireAuth, requireRole('admin', 'manager'), controller.update);
router.delete('/:id', requireAuth, requireRole('admin', 'manager'), controller.remove);

export default router;
