import { Router } from 'express';
import { handleResendWebhook } from '../controllers/emailWebhooks.controller';

// No requireAuth — see app.ts's mount comment and the controller's own header
// comment for why this route is deliberately public.
const router = Router();
router.post('/', handleResendWebhook);

export default router;
