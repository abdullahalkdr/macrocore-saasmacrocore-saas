import { Router } from 'express';
import { list, create, update, remove } from '../controllers/wasteRecords.controller';
import { requireAuth } from '../middleware/auth';
import { requireRoleOrPermission } from '../middleware/requirePermission';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', create);
router.patch('/:id', requireRoleOrPermission(['admin', 'manager'], 'edit_waste'), update);
router.delete('/:id', requireRoleOrPermission(['admin', 'manager'], 'edit_waste'), remove);

export default router;
