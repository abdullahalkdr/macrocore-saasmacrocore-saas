import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useLangStore, isRTL } from './store/langStore';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import ProductsPage from './pages/ProductsPage';
import EmployeesPage from './pages/EmployeesPage';
import ShiftPage from './pages/ShiftPage';
import UsersPage from './pages/UsersPage';
import ReportsPage from './pages/ReportsPage';
import RawMaterialsPage from './pages/RawMaterialsPage';
import RawMaterialBatchesPage from './pages/RawMaterialBatchesPage';
import StockTransfersPage from './pages/StockTransfersPage';
import LocationsPage from './pages/LocationsPage';
import ExpensesPage from './pages/ExpensesPage';
import WasteRecordsPage from './pages/WasteRecordsPage';
import PayrollPage from './pages/PayrollPage';
import SupportTicketsPage from './pages/SupportTicketsPage';
import SettingsPage from './pages/SettingsPage';
import AttendancePage from './pages/AttendancePage';
import LeaveRequestsPage from './pages/LeaveRequestsPage';
import OfficialDocumentsPage from './pages/OfficialDocumentsPage';
import CompanyFilesPage from './pages/CompanyFilesPage';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import RequireRole from './components/RequireRole';

const MANAGER_ROLES = ['admin', 'manager'];

export default function App() {
  const lang = useLangStore((s) => s.lang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = isRTL(lang) ? 'rtl' : 'ltr';
  }, [lang]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
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
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/waste" element={<WasteRecordsPage />} />
            <Route
              path="/payroll"
              element={
                <RequireRole roles={MANAGER_ROLES}>
                  <PayrollPage />
                </RequireRole>
              }
            />
            <Route path="/support" element={<SupportTicketsPage />} />
            <Route path="/attendance" element={<AttendancePage />} />
            <Route path="/leave-requests" element={<LeaveRequestsPage />} />
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
          </Route>
        </Route>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
