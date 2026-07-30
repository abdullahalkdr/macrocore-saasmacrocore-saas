import { Router } from 'express';
import { register, login, refresh } from '../controllers/auth.controller';
import { rateLimit } from '../middleware/rateLimit';

const router = Router();

const authLimiter = rateLimit(10, 60_000); // 10 requests / minute / IP

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/refresh', authLimiter, refresh);

export default router;
