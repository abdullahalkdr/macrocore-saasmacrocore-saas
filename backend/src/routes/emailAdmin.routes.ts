import { Router } from 'express';
import { sendTestEmail, listEmailLog, retryEmailJob } from '../controllers/emailAdmin.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

// Whole router admin-only — same shape as apiKeys.routes.ts/permissions.routes.ts.
// Sending test email and reading the delivery log are both sensitive enough
// (real send capability, and recipient addresses/subjects across the company)
// to keep at admin, not widen to manager, at least for this first pass.
router.use(requireAuth, requireRole('admin'));
router.post('/test', sendTestEmail);
router.get('/log', listEmailLog);
router.post('/:id/retry', retryEmailJob);

export default router;
