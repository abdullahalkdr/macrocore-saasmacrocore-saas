import { Router } from 'express';
import { list, getOne, create, update, remove } from '../controllers/costCenters.controller';
import { requireAuth } from '../middleware/auth';
import { requireRoleOrPermission } from '../middleware/requirePermission';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.get('/:id', getOne);
router.post('/', requireRoleOrPermission(['admin', 'manager'], 'manage_cost_centers'), create);
router.patch('/:id', requireRoleOrPermission(['admin', 'manager'], 'manage_cost_centers'), update);
router.delete('/:id', requireRoleOrPermission(['admin', 'manager'], 'manage_cost_centers'), remove);

export default router;
