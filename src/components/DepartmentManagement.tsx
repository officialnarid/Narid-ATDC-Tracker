import React, { useState } from 'react';
import { Building2, Plus, Edit2, CheckCircle, XCircle, X, FileSpreadsheet, Download } from 'lucide-react';
import { Department, UserRoleRecord } from '../types';
import { saveDepartment } from '../services/masterService';
import { RolePermissionRecord, hasModulePermission } from '../services/permissionService';
import { useBulkSelection } from '../hooks/useBulkSelection';
import {
  BulkActionBar,
  BulkExecutionSummary,
  BulkProgressState,
  SelectAllCheckbox,
} from './BulkActionBar';
import { BulkConfirmModal } from './BulkConfirmModal';
import {
  executeMasterBulkStatus,
  exportChunkedToCsv,
  exportChunkedToExcel,
} from '../services/bulkActionService';

interface DepartmentManagementProps {
  departments: Department[];
  onRefresh: () => void;
  currentUserRole?: UserRoleRecord | null;
  rolePermissions?: Record<string, RolePermissionRecord>;
}

export const DepartmentManagement: React.FC<DepartmentManagementProps> = ({
  departments,
  onRefresh,
  currentUserRole,
  rolePermissions,
}) => {
  const canAdd = currentUserRole
    ? hasModulePermission(currentUserRole.role, 'departments', 'add', rolePermissions)
    : true;
  const canEdit = currentUserRole
    ? hasModulePermission(currentUserRole.role, 'departments', 'edit', rolePermissions)
    : true;
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDept, setEditingDept] = useState<Partial<Department>>({
    id: '',
    name: '',
    code: '',
    status: 'Active',
  });
  const [isSaving, setIsSaving] = useState(false);

  const handleOpenAdd = () => {
    setEditingDept({
      id: `dept_${Date.now()}`,
      name: '',
      code: '',
      status: 'Active',
    });
    setIsModalOpen(true);
  };

  const handleOpenEdit = (dept: Department) => {
    setEditingDept({ ...dept });
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDept.name) return;
    setIsSaving(true);
    try {
      await saveDepartment(editingDept as Department);
      setIsModalOpen(false);
      onRefresh();
    } catch (err: any) {
      alert(`Error saving department: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (dept: Department) => {
    const nextStatus = dept.status === 'Active' ? 'Inactive' : 'Active';
    try {
      await saveDepartment({ ...dept, status: nextStatus });
      onRefresh();
    } catch (err: any) {
      alert(`Error toggling department: ${err.message}`);
    }
  };

  const bulk = useBulkSelection<Department>({
    items: departments,
    paginatedItems: departments,
    getId: (d) => d.id,
  });

  const [bulkProgress, setBulkProgress] = useState<BulkProgressState | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkExecutionSummary | null>(null);
  const [pendingStatus, setPendingStatus] = useState<'Active' | 'Inactive' | null>(null);
  const [isBulkBusy, setIsBulkBusy] = useState(false);

  const handleBulkExport = async (format: 'xlsx' | 'csv') => {
    const selected = bulk.selectedItems;
    if (selected.length === 0 || isBulkBusy) return;
    setIsBulkBusy(true);
    setBulkSummary(null);
    setBulkProgress({ label: `Exporting ${selected.length} departments...`, completed: 0, total: selected.length });
    try {
      const cols = [
        { header: 'Department Name', key: 'name' },
        { header: 'Code', key: 'code' },
        { header: 'Status', key: 'status' },
      ];
      const rows = selected.map((d) => ({ name: d.name, code: d.code, status: d.status }));
      const fn = format === 'xlsx' ? exportChunkedToExcel : exportChunkedToCsv;
      const out = await fn(rows, cols, 'Departments_Selected', {
        auditTargetType: 'DEPARTMENTS',
        auditSource: 'DEPARTMENT_MANAGEMENT',
      });
      setBulkSummary({ type: 'success', title: `Exported ${out.rowCount} Departments`, message: `Downloaded "${out.fileName}".`, savedCount: out.rowCount });
      bulk.clearSelection();
    } catch (err: any) {
      setBulkSummary({ type: 'error', title: 'Export Failed', message: err?.message || 'Unable to export departments.' });
    } finally {
      setBulkProgress(null);
      setIsBulkBusy(false);
    }
  };

  const handleBulkStatus = async () => {
    if (!pendingStatus || bulk.selectedIdArray.length === 0) return;
    setIsBulkBusy(true);
    setBulkSummary(null);
    setBulkProgress({ label: `Updating ${bulk.selectedCount} departments...`, completed: 0, total: bulk.selectedCount });
    try {
      const res = await executeMasterBulkStatus({ resource: 'departments', ids: bulk.selectedIdArray, status: pendingStatus });
      setBulkSummary({
        type: res.failedCount > 0 ? 'partial' : 'success',
        title: `Updated ${res.savedCount} Department(s)`,
        message: `Status set to ${pendingStatus}.`,
        savedCount: res.savedCount,
        failedCount: res.failedCount,
      });
      setPendingStatus(null);
      bulk.clearSelection();
      onRefresh();
    } catch (err: any) {
      setBulkSummary({ type: 'error', title: 'Bulk Status Update Failed', message: err?.message || 'Permission or server error.' });
    } finally {
      setBulkProgress(null);
      setIsBulkBusy(false);
    }
  };

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <Building2 className="w-5 h-5 text-cyan-600" />
            <span>DEPARTMENT MANAGEMENT</span>
          </h2>
          <p className="text-xs text-slate-500">
            Configure factory departments (Production, Quality, Store, PPC, R&D, Others)
          </p>
        </div>

        {canAdd && (
          <button
            onClick={handleOpenAdd}
            className="bg-cyan-600 hover:bg-cyan-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-1.5 shadow-sm transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add Department</span>
          </button>
        )}
      </div>

      <BulkActionBar
        selectedCount={bulk.selectedCount}
        totalFilteredCount={bulk.totalFilteredCount}
        currentPageCount={bulk.currentPageCount}
        isAllFilteredSelected={bulk.isAllFilteredSelected}
        isPageAllSelected={bulk.isPageAllSelected}
        recordLabel="departments"
        onClearSelection={bulk.clearSelection}
        progress={bulkProgress}
        summary={bulkSummary}
        onDismissSummary={() => setBulkSummary(null)}
        actions={[
          { id: 'xlsx', label: 'Export Excel', icon: <FileSpreadsheet className="w-3.5 h-3.5" />, tone: 'emerald', onClick: () => handleBulkExport('xlsx') },
          { id: 'csv', label: 'Export CSV', icon: <Download className="w-3.5 h-3.5" />, tone: 'default', onClick: () => handleBulkExport('csv') },
          { id: 'activate', label: 'Activate', icon: <CheckCircle className="w-3.5 h-3.5" />, tone: 'primary', hidden: !canEdit, onClick: () => setPendingStatus('Active') },
          { id: 'deactivate', label: 'Deactivate', icon: <XCircle className="w-3.5 h-3.5" />, tone: 'amber', hidden: !canEdit, onClick: () => setPendingStatus('Inactive') },
        ]}
      />

      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
            <tr>
              <th className="py-3 px-3 w-10 text-center">
                <SelectAllCheckbox
                  checked={bulk.isPageAllSelected}
                  indeterminate={bulk.isPageIndeterminate}
                  disabled={departments.length === 0 || isBulkBusy}
                  onChange={bulk.togglePageSelection}
                  ariaLabel="Select all departments"
                />
              </th>
              <th className="py-3 px-4">Department Name</th>
              <th className="py-3 px-4">Code</th>
              <th className="py-3 px-4 text-center">Status</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {departments.map(dept => {
              const isChecked = bulk.isSelected(dept.id);
              return (
              <tr key={dept.id} className={isChecked ? 'bg-blue-50/60 hover:bg-blue-50/90' : 'hover:bg-slate-50'}>
                <td className="py-3 px-3 text-center">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={isBulkBusy}
                    onChange={() => bulk.toggleOne(dept.id)}
                    aria-label={`Select department ${dept.name}`}
                    className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                  />
                </td>
                <td className="py-3 px-4 font-bold text-slate-900">{dept.name}</td>
                <td className="py-3 px-4 font-mono text-slate-600">{dept.code}</td>
                <td className="py-3 px-4 text-center">
                  <button
                    onClick={() => canEdit && handleToggleStatus(dept)}
                    disabled={!canEdit}
                    className={`px-2 py-0.5 rounded text-[11px] font-bold inline-flex items-center gap-1 ${
                      dept.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {dept.status === 'Active' ? <CheckCircle className="w-3 h-3 text-emerald-600" /> : <XCircle className="w-3 h-3 text-slate-500" />}
                    <span>{dept.status}</span>
                  </button>
                </td>
                <td className="py-3 px-4 text-right">
                  {canEdit && (
                    <button
                      onClick={() => handleOpenEdit(dept)}
                      className="p-1.5 rounded hover:bg-slate-100 text-slate-700 border border-slate-200"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-sm w-full p-5 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 mb-4">
              <h3 className="font-bold text-slate-800 text-sm">
                {editingDept.name ? 'Edit Department' : 'Add Department'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="flex flex-col gap-3 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Department Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Quality"
                  value={editingDept.name || ''}
                  onChange={(e) => setEditingDept({ ...editingDept, name: e.target.value })}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-semibold"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Code</label>
                <input
                  type="text"
                  placeholder="e.g. QC"
                  value={editingDept.code || ''}
                  onChange={(e) => setEditingDept({ ...editingDept, code: e.target.value.toUpperCase() })}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono uppercase"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100 mt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="bg-slate-100 text-slate-700 px-3 py-1.5 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="bg-cyan-600 text-white px-4 py-1.5 rounded font-medium disabled:opacity-50"
                >
                  {isSaving ? 'Saving...' : 'Save Department'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <BulkConfirmModal
        isOpen={Boolean(pendingStatus)}
        title={pendingStatus === 'Active' ? 'Activate Selected Departments?' : 'Deactivate Selected Departments?'}
        description={`Set status to ${pendingStatus} for ${bulk.selectedCount} selected department(s).`}
        selectedCount={bulk.selectedCount}
        confirmLabel={`${pendingStatus === 'Active' ? 'Activate' : 'Deactivate'} ${bulk.selectedCount} Department(s)`}
        tone={pendingStatus === 'Inactive' ? 'amber' : 'primary'}
        isBusy={isBulkBusy}
        onConfirm={handleBulkStatus}
        onCancel={() => !isBulkBusy && setPendingStatus(null)}
      />
    </div>
  );
};
