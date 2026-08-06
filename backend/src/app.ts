import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import authRoutes from './routes/auth.routes';
import companyRoutes from './routes/company.routes';
import usersRoutes from './routes/users.routes';
import productsRoutes from './routes/products.routes';
import shiftsRoutes from './routes/shifts.routes';
import salesRoutes from './routes/sales.routes';
import rawMaterialsRoutes from './routes/rawMaterials.routes';
import rawMaterialBatchesRoutes from './routes/rawMaterialBatches.routes';
import stockTransfersRoutes from './routes/stockTransfers.routes';
import inventoryRoutes from './routes/inventory.routes';
import employeesRoutes from './routes/employees.routes';
import locationsRoutes from './routes/locations.routes';
import reportsRoutes from './routes/reports.routes';
import expensesRoutes from './routes/expenses.routes';
import wasteRecordsRoutes from './routes/wasteRecords.routes';
import payrollRoutes from './routes/payroll.routes';
import supportTicketsRoutes from './routes/supportTickets.routes';
import syncRoutes from './routes/sync.routes';
import adminRoutes from './routes/admin.routes';
import attendanceRoutes from './routes/attendance.routes';
import leaveRequestsRoutes from './routes/leaveRequests.routes';
import officialDocumentsRoutes from './routes/officialDocuments.routes';
import companyFilesRoutes from './routes/companyFiles.routes';
import apiKeysRoutes from './routes/apiKeys.routes';
import customFieldsRoutes from './routes/customFields.routes';
import documentTemplatesRoutes from './routes/documentTemplates.routes';
import auditLogRoutes from './routes/auditLog.routes';
import shiftSchedulesRoutes from './routes/shiftSchedules.routes';
import suppliersRoutes from './routes/suppliers.routes';
import purchaseOrdersRoutes from './routes/purchaseOrders.routes';
import permissionsRoutes from './routes/permissions.routes';
import customersRoutes from './routes/customers.routes';
import salesQuotesRoutes from './routes/salesQuotes.routes';
import salesInvoicesRoutes from './routes/salesInvoices.routes';
import notificationsRoutes from './routes/notifications.routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requireAuth } from './middleware/auth';
import { requireActiveSubscription } from './middleware/subscription';
import { requirePlanLevel } from './middleware/requirePlan';

export const app = express();

app.use(cors({ origin: env.CORS_ORIGIN }));
// Raised from Express's 100kb default — employee photos/certificates and leave-request
// attachments are stored as base64 JSON fields (no object storage wired up yet).
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// requireAuth here is redundant with the `router.use(requireAuth)` each route file
// already does internally — kept anyway so requireActiveSubscription always has
// req.auth.companyId populated regardless of route-file ordering. Cheap (one extra
// JWT verify), zero behavior change for routes that were already requiring auth.
//
// Exempt from the subscription gate: /api/auth (can't gate login itself), /api/company
// (a blocked company must still be able to read its own plan/status to know what to
// renew), /api/support/tickets (blocked companies can still ask for help), and
// /api/admin (macrocore's own cross-tenant dashboard, gated separately by
// requireAdminKey — never tied to any one company's subscription).
const guarded = [requireAuth, requireActiveSubscription];

// Plan-tier gating (docs/macrocore-خارطة-طريق.md, "المرحلة 4") — layered on top of
// `guarded`, never instead of it. Deliberately NOT applied to /shifts or /sales: every
// sale requires an open shift (sales.controller.ts create() requires shift_id), so
// gating either behind a paid tier would make it impossible for a Bronze customer to
// sell anything at all — the roadmap's own table lists "Shifts" as Silver+, but that
// reads as future product positioning, not something safe to enforce against the
// current single-flow POS. Locations are similarly never route-gated (every plan
// needs at least one location to open a shift); "multiple locations" is enforced as a
// quantity cap instead — see locations.controller.ts create().
const silver = (label: string) => [...guarded, requirePlanLevel(2, label)];
const gold = (label: string) => [...guarded, requirePlanLevel(3, label)];

app.use('/api/auth', authRoutes);
app.use('/api/company', companyRoutes);
app.use('/api/users', ...guarded, usersRoutes);
app.use('/api/products', ...guarded, productsRoutes);
app.use('/api/shifts', ...guarded, shiftsRoutes);
app.use('/api/sales', ...guarded, salesRoutes);
app.use('/api/raw-materials', ...guarded, rawMaterialsRoutes);
app.use('/api/raw-material-batches', ...silver('Raw material batches'), rawMaterialBatchesRoutes);
app.use('/api/stock-transfers', ...silver('Stock transfers'), stockTransfersRoutes);
app.use('/api/inventory', ...silver('Inventory overview'), inventoryRoutes);
app.use('/api/employees', ...silver('Employee management'), employeesRoutes);
app.use('/api/locations', ...guarded, locationsRoutes);
app.use('/api/reports', ...guarded, reportsRoutes);
app.use('/api/expenses', ...guarded, expensesRoutes);
app.use('/api/waste-records', ...silver('Waste tracking'), wasteRecordsRoutes);
app.use('/api/payroll', ...gold('Payroll'), payrollRoutes);
app.use('/api/support/tickets', supportTicketsRoutes);
app.use('/api/sync', ...guarded, syncRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/attendance', ...silver('Attendance tracking'), attendanceRoutes);
app.use('/api/leave-requests', ...silver('Leave requests'), leaveRequestsRoutes);
app.use('/api/official-documents', ...silver('Official documents'), officialDocumentsRoutes);
app.use('/api/company-files', ...silver('Company files'), companyFilesRoutes);
app.use('/api/api-keys', ...gold('API access'), apiKeysRoutes);
app.use('/api/custom-fields', ...gold('Custom fields'), customFieldsRoutes);
app.use('/api/document-templates', ...gold('Document templates'), documentTemplatesRoutes);
app.use('/api/audit-log', ...gold('Audit log'), auditLogRoutes);
app.use('/api/shift-schedules', ...silver('Shift scheduling'), shiftSchedulesRoutes);
app.use('/api/suppliers', ...silver('Suppliers'), suppliersRoutes);
app.use('/api/purchase-orders', ...silver('Purchase orders'), purchaseOrdersRoutes);
app.use('/api/permissions', ...gold('Granular permissions'), permissionsRoutes);
app.use('/api/customers', ...silver('Customer / loyalty tracking'), customersRoutes);
// New B2B sales suite ("المبيعات" — quotes/invoices, separate from POS/shift sales;
// see the sales_quotes/sales_invoices migration comments). Gated the same as
// /api/customers since they're the same product tier (Silver+).
app.use('/api/sales-quotes', ...silver('Sales quotes'), salesQuotesRoutes);
app.use('/api/sales-invoices', ...silver('Sales invoices'), salesInvoicesRoutes);
app.use('/api/notifications', ...guarded, notificationsRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
