import { Router } from 'express';
import { register, login, refresh, changePassword } from '../controllers/auth.controller';
import { rateLimit } from '../middleware/rateLimit';
import { requireAuth } from '../middleware/auth';

const router = Router();

const authLimiter = rateLimit(10, 60_000); // 10 requests / minute / IP

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/refresh', authLimiter, refresh);
router.post('/change-password', requireAuth, authLimiter, changePassword);

export default router;
