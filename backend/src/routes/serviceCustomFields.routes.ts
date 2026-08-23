import { Router } from 'express';
import { list, create, update, remove } from '../controllers/serviceCustomFields.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

router.use(requireAuth);
// GET supports an optional ?request_type_id= filter (see the controller) —
// any authenticated role, same reasoning as the other two ITSM routes.
router.get('/', list);
router.post('/', requireRole('admin', 'manager'), create);
router.put('/:id', requireRole('admin', 'manager'), update);
router.delete('/:id', requireRole('admin', 'manager'), remove);

export default router;
