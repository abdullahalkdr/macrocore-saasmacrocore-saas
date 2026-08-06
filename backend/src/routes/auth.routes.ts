import { Router } from 'express';
import {
  register,
  login,
  refresh,
  changePassword,
  googleStart,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
} from '../controllers/auth.controller';
import { rateLimit } from '../middleware/rateLimit';
import { requireAuth } from '../middleware/auth';

const router = Router();

const authLimiter = rateLimit(10, 60_000); // 10 requests / minute / IP

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/google', authLimiter, googleStart);
router.post('/refresh', authLimiter, refresh);
router.post('/change-password', requireAuth, authLimiter, changePassword);
router.post('/verify-email', authLimiter, verifyEmail);
router.post('/resend-verification', requireAuth, authLimiter, resendVerification);
router.post('/forgot-password', authLimiter, forgotPassword);
router.post('/reset-password', authLimiter, resetPassword);

export default router;
