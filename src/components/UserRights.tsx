import React, { useState } from 'react';
import { 
  ShieldCheck, 
  ShieldAlert, 
  UserCheck, 
  Lock, 
  Key, 
  Plus, 
  Check, 
  X, 
  Info,
  Layers,
  Settings
} from 'lucide-react';
import { UserRoleRecord, UserRoleType } from '../types';

export const UserRights: React.FC = () => {
  const [users, setUsers] = useState<UserRoleRecord[]>([]);

  const [activeTab, setActiveTab] = useState<'roles' | 'matrix' | 'users'>('matrix');

  const modules = [
    { key: 'dashboard', label: '1. Dashboard' },
    { key: 'scanner', label: '2. Attendance Scanner' },
    { key: 'employees', label: '3. Employee Master' },
    { key: 'excel_import', label: '4. Excel Import / Update' },
    { key: 'qr_codes', label: '5. QR Code Management' },
    { key: 'floors', label: '6. Line Master' },
    { key: 'sections', label: '7. Section Master' },
    { key: 'departments', label: '8. Department Master' },
    { key: 'shifts', label: '9. Shift Management' },
    { key: 'history', label: '10. Attendance History' },
    { key: 'reports', label: '11. Reports & Export' },
    { key: 'user_rights', label: '12. User Rights & Authorization' },
    { key: 'settings', label: '13. System Settings' },
  ];

  const rolePermissions: Record<UserRoleType, string[]> = {
    SUPER_ADMIN: ['all'],
    ADMIN: ['dashboard', 'scanner', 'employees', 'history', 'reports', 'qr_codes'],
    USER: ['scanner'],
  };

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {/* Title */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-blue-600" />
            <span>USER RIGHTS & AUTHORIZATION</span>
          </h2>
          <p className="text-xs text-slate-500">
            Role definitions, permission matrix, and access control infrastructure
          </p>
        </div>

        <div className="px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs font-semibold flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-amber-600" />
          <span>PHASE 1: AUTH PENDING ACTIVATION</span>
        </div>
      </div>

      {/* Prominent Architectural Notice */}
      <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 flex items-start gap-3">
        <Info className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <h4 className="font-bold text-sm text-amber-950">
            Specification Compliance Note: Authentication Pending Activation
          </h4>
          <p className="text-amber-800 leading-relaxed">
            As specified in the project requirements, no login credentials or passwords are required for this phase. The application runs in an internal factory floor environment. The complete Role-Based Access Control (RBAC) data models, role definitions, and permission matrices below are staged and ready for future production activation.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        <button
          onClick={() => setActiveTab('matrix')}
          className={`pb-2.5 px-3 text-xs font-semibold transition border-b-2 ${
            activeTab === 'matrix' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          Module Permission Matrix
        </button>
        <button
          onClick={() => setActiveTab('roles')}
          className={`pb-2.5 px-3 text-xs font-semibold transition border-b-2 ${
            activeTab === 'roles' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          Role Definitions (3 Roles)
        </button>
        <button
          onClick={() => setActiveTab('users')}
          className={`pb-2.5 px-3 text-xs font-semibold transition border-b-2 ${
            activeTab === 'users' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          User Accounts Directory Placeholder
        </button>
      </div>

      {/* TAB 1: PERMISSION MATRIX */}
      {activeTab === 'matrix' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
          <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wide">
              Module-by-Module Access Matrix
            </h3>
            <span className="text-[11px] text-slate-500">Configured for future RBAC enforcement</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-4">System Module</th>
                  <th className="py-2.5 px-4 text-center">SUPER ADMIN</th>
                  <th className="py-2.5 px-4 text-center">ADMIN (Supervisor)</th>
                  <th className="py-2.5 px-4 text-center">USER (Gate Operator)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {modules.map(mod => {
                  const superAdminHas = true;
                  const adminHas = rolePermissions.ADMIN.includes(mod.key);
                  const userHas = rolePermissions.USER.includes(mod.key);

                  return (
                    <tr key={mod.key} className="hover:bg-slate-50">
                      <td className="py-2.5 px-4 font-medium text-slate-800">{mod.label}</td>
                      <td className="py-2.5 px-4 text-center">
                        <span className="w-5 h-5 mx-auto rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
                          ✓
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        {adminHas ? (
                          <span className="w-5 h-5 mx-auto rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
                            ✓
                          </span>
                        ) : (
                          <span className="w-5 h-5 mx-auto rounded-full bg-slate-100 text-slate-400 flex items-center justify-center">
                            ✕
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        {userHas ? (
                          <span className="w-5 h-5 mx-auto rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
                            ✓
                          </span>
                        ) : (
                          <span className="w-5 h-5 mx-auto rounded-full bg-slate-100 text-slate-400 flex items-center justify-center">
                            ✕
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: ROLES */}
      {activeTab === 'roles' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-bold text-slate-900 text-sm">SUPER ADMIN</h3>
              <span className="text-[10px] bg-red-100 text-red-800 px-2 py-0.5 rounded font-bold">Full Access</span>
            </div>
            <p className="text-xs text-slate-600 mt-3">
              Complete administrative access across all 13 modules, including master data modification, Excel imports, user authorization, and system settings.
            </p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-bold text-slate-900 text-sm">ADMIN (Supervisor)</h3>
              <span className="text-[10px] bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-bold">Production Lead</span>
            </div>
            <p className="text-xs text-slate-600 mt-3">
              Access to Dashboard, Line-wise availability, Department reports, Attendance history, Attendance corrections, and QR card generation.
            </p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-bold text-slate-900 text-sm">USER (Gate Operator)</h3>
              <span className="text-[10px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-bold">Scanner Only</span>
            </div>
            <p className="text-xs text-slate-600 mt-3">
              Restricted to dedicated Attendance Scanner only. Enables continuous QR scanning for Punch In and Punch Out with zero administrative controls.
            </p>
          </div>
        </div>
      )}

      {/* TAB 3: USER ACCOUNTS DIRECTORY */}
      {activeTab === 'users' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
              <tr>
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Login Identifier</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Future Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    <p className="font-semibold text-xs text-slate-700">No active login credentials configured for Phase 1.</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">Authentication & user login activation is scheduled for Phase 2.</p>
                  </td>
                </tr>
              ) : (
                users.map(u => (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="py-3 px-4 font-semibold text-slate-900">{u.name}</td>
                    <td className="py-3 px-4 font-mono text-slate-600">{u.email}</td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-bold text-[10px]">
                        {u.role}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px]">
                        {u.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-slate-400">
                      <span>Password Reset (Pending)</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
