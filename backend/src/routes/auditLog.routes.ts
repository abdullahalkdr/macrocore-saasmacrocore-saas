import { Router } from 'express';
import { list, getChanges } from '../controllers/auditLog.controller';
import { requireAuth } from '../middleware/auth';
import { requireRoleOrPermission } from '../middleware/requirePermission';

const router = Router();

router.use(requireAuth);
// admin/manager pass unconditionally as before; 'view_audit_log' widens access to
// anyone individually or job-role granted it (e.g. IT department staff) without
// changing what admin/manager already see.
router.get('/', requireRoleOrPermission(['admin', 'manager'], 'view_audit_log'), list);
router.get('/:id/changes', requireRoleOrPermission(['admin', 'manager'], 'view_audit_log'), getChanges);

export default router;
