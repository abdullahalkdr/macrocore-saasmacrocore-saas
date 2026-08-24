import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useLangStore, isRTL } from './store/langStore';
import { useThemeStore } from './store/themeStore';
import { useAuthStore } from './store/authStore';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import PricingPage from './pages/PricingPage';
import SubscriptionExpiredPage from './pages/SubscriptionExpiredPage';
import PlatformAdminPage from './pages/PlatformAdminPage';
import UpgradeModal from './components/UpgradeModal';
import DashboardPage from './pages/DashboardPage';
import ProductsPage from './pages/ProductsPage';
import EmployeesPage from './pages/EmployeesPage';
import ShiftPage from './pages/ShiftPage';
import UsersPage from './pages/UsersPage';
import ReportsPage from './pages/ReportsPage';
import RawMaterialsPage from './pages/RawMaterialsPage';
import RawMaterialBatchesPage from './pages/RawMaterialBatchesPage';
import InventoryOverviewPage from './pages/InventoryOverviewPage';
import StockTransfersPage from './pages/StockTransfersPage';
import LocationsPage from './pages/LocationsPage';
import CostCentersPage from './pages/CostCentersPage';
import ProjectsPage from './pages/ProjectsPage';
import PeriodClosingPage from './pages/PeriodClosingPage';
import ExpensesPage from './pages/ExpensesPage';
import WasteRecordsPage from './pages/WasteRecordsPage';
import PayrollPage from './pages/PayrollPage';
import HRDashboardPage from './pages/HRDashboardPage';
import PerformancePage from './pages/PerformancePage';
import SLAManagementPage from './pages/SLAManagementPage';
import PoliciesPage from './pages/PoliciesPage';
import SupportTicketsPage from './pages/SupportTicketsPage';
import ServiceCatalogSettingsPage from './pages/ServiceCatalogSettingsPage';
import DepartmentsPage from './pages/DepartmentsPage';
import SettingsPage from './pages/SettingsPage';
import AccountSettingsPage from './pages/account/AccountSettingsPage';
import AttendancePage from './pages/AttendancePage';
import LeaveRequestsPage from './pages/LeaveRequestsPage';
import OfficialDocumentsPage from './pages/OfficialDocumentsPage';
import CompanyFilesPage from './pages/CompanyFilesPage';
import AuditLogPage from './pages/AuditLogPage';
import ShiftSchedulePage from './pages/ShiftSchedulePage';
import SuppliersPage from './pages/SuppliersPage';
import PurchaseOrdersPage from './pages/PurchaseOrdersPage';
import PermissionsPage from './pages/PermissionsPage';
import ApprovalsInboxPage from './pages/ApprovalsInboxPage';
import CustomersPage from './pages/CustomersPage';
import SalesQuotesPage from './pages/SalesQuotesPage';
import SalesInvoicesPage from './pages/SalesInvoicesPage';
import CustomerReceiptsPage from './pages/CustomerReceiptsPage';
import RecurringInvoicesPage from './pages/RecurringInvoicesPage';
import CreditNotesPage from './pages/CreditNotesPage';
import CashInvoicesPage from './pages/CashInvoicesPage';
import SalesSettingsPage from './pages/SalesSettingsPage';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import RequireRole from './components/RequireRole';

const MANAGER_ROLES = ['admin', 'manager'];
const ADMIN_ROLES = ['admin'];

// "/" used to always bounce to /dashboard (which then bounced anonymous visitors to
// /login) — fine when this was an internal tool, wrong now that macrocore is sold
// self-serve: a logged-out visitor hitting the bare domain should land on the pricing
// page, not a login form with no context. Signed-in users still go straight to their
// dashboard.
function Home() {
  const token = useAuthStore((s) => s.token);
  return <Navigate to={token ? '/dashboard' : '/pricing'} replace />;
}

export default function App() {
  const lang = useLangStore((s) => s.lang);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = isRTL(lang) ? 'rtl' : 'ltr';
  }, [lang]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/subscription-expired" element={<SubscriptionExpiredPage />} />
        <Route path="/platform-admin" element={<PlatformAdminPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<Layout />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/shift" element={<ShiftPage />} />
            <Route
              path="/products"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <ProductsPage />
                </RequireRole>
              }
            />
            <Route
              path="/employees"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <EmployeesPage />
                </RequireRole>
              }
            />
            <Route
              path="/users"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <UsersPage />
                </RequireRole>
              }
            />
            <Route path="/reports" element={<ReportsPage />} />
            <Route
              path="/raw-materials"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <RawMaterialsPage />
                </RequireRole>
              }
            />
            <Route
              path="/raw-material-batches"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <RawMaterialBatchesPage />
                </RequireRole>
              }
            />
            <Route
              path="/inventory"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <InventoryOverviewPage />
                </RequireRole>
              }
            />
            <Route
              path="/stock-transfers"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <StockTransfersPage />
                </RequireRole>
              }
            />
            <Route
              path="/locations"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <LocationsPage />
                </RequireRole>
              }
            />
            <Route
              path="/cost-centers"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <CostCentersPage />
                </RequireRole>
              }
            />
            <Route
              path="/projects"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <ProjectsPage />
                </RequireRole>
              }
            />
            <Route
              path="/period-closing"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <PeriodClosingPage />
                </RequireRole>
              }
            />
            <Route
              path="/suppliers"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <SuppliersPage />
                </RequireRole>
              }
            />
            <Route
              path="/purchase-orders"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <PurchaseOrdersPage />
                </RequireRole>
              }
            />
            <Route
              path="/permissions"
              element={
                <RequireRole roles={ADMIN_ROLES}>
                  <PermissionsPage />
                </RequireRole>
              }
            />
            <Route
              path="/approvals"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <ApprovalsInboxPage />
                </RequireRole>
              }
            />
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route
              path="/quotes"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <SalesQuotesPage />
                </RequireRole>
              }
            />
            <Route
              path="/sales-invoices"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <SalesInvoicesPage />
                </RequireRole>
              }
            />
            <Route
              path="/customer-receipts"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <CustomerReceiptsPage />
                </RequireRole>
              }
            />
            <Route
              path="/recurring-invoices"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <RecurringInvoicesPage />
                </RequireRole>
              }
            />
            <Route
              path="/credit-notes"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <CreditNotesPage />
                </RequireRole>
              }
            />
            <Route
              path="/cash-invoices"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <CashInvoicesPage />
                </RequireRole>
              }
            />
            <Route
              path="/sales-settings"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <SalesSettingsPage />
                </RequireRole>
              }
            />
            <Route path="/waste" element={<WasteRecordsPage />} />
            <Route
              path="/payroll"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <PayrollPage />
                </RequireRole>
              }
            />
            <Route
              path="/hr-dashboard"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <HRDashboardPage />
                </RequireRole>
              }
            />
            <Route
              path="/performance"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <PerformancePage />
                </RequireRole>
              }
            />
            <Route
              path="/sla-management"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <SLAManagementPage />
                </RequireRole>
              }
            />
            <Route path="/support" element={<SupportTicketsPage />} />
            {/* Service Catalog management (ITSM pivot Step 3) — gated the same
                as SLAManagementPage/the old ticket_categories admin tab
                (MANAGER_ROLES), matching what the backend actually allows
                (serviceCategories/serviceRequestTypes/serviceCustomFields
                routes require admin OR manager, not admin-only). */}
            <Route
              path="/service-catalog"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <ServiceCatalogSettingsPage />
                </RequireRole>
              }
            />
            {/* MIGRATION_048 — dynamic per-company departments (HR/Operations/IT/
                Marketing/Finance/Legal, etc.), gated the same as /employees
                itself (MANAGER_ROLES) even though the /api/departments route
                is not plan-tier gated — a plain employee has no reason to see
                a department-management page, they just see the department
                label wherever a name is shown (ticket assignee, etc.). */}
            <Route
              path="/departments"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <DepartmentsPage />
                </RequireRole>
              }
            />
            <Route path="/attendance" element={<AttendancePage />} />
            <Route path="/leave-requests" element={<LeaveRequestsPage />} />
            <Route path="/policies" element={<PoliciesPage />} />
            <Route path="/shift-schedule" element={<ShiftSchedulePage />} />
            <Route
              path="/official-documents"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <OfficialDocumentsPage />
                </RequireRole>
              }
            />
            <Route
              path="/company-files"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <CompanyFilesPage />
                </RequireRole>
              }
            />
            <Route
              path="/settings"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <SettingsPage />
                </RequireRole>
              }
            />
            <Route
              path="/audit-log"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <AuditLogPage />
                </RequireRole>
              }
            />
            {/* Account/company/billing/users&roles/branches/customizations/API keys — separate
                from the operational SettingsPage above (fixed costs, commissions, attendance
                timing). Open to every role; the page itself hides admin-only sections. */}
            <Route path="/account" element={<AccountSettingsPage />} />
          </Route>
        </Route>
        <Route path="/" element={<Home />} />
        <Route path="*" element={<Home />} />
      </Routes>
      <UpgradeModal />
    </BrowserRouter>
  );
}
