import { Router } from 'express';
import { list, create, getOne, reply, updateStatus } from '../controllers/supportTickets.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.get('/', list);
router.post('/', create);
router.get('/:id', getOne);
router.post('/:id/reply', reply);
router.patch('/:id', updateStatus);

export default router;
