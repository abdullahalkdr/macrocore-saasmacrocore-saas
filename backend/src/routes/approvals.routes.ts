import { Router } from 'express';
import { createRequest, listPending, actionRequest, getApprovalSummary } from '../controllers/approvals.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

// No role restriction at the route level — createRequest is open to any linked
// employee (filing a request never needs elevated access), and listPending/
// actionRequest each do their own eligibility filtering per-row inside the
// controller (module -> permission mapping, maker-checker), since "who can approve
// what" depends on the specific request, not a single role gate.
router.use(requireAuth);
router.post('/request', createRequest);
router.get('/pending', listPending);
// Read-only, open to any authenticated company user — see getApprovalSummary's own
// header for why (the requester themselves needs this too, not just approvers).
router.get('/summary', getApprovalSummary);
router.post('/:id/action', actionRequest);

export default router;
