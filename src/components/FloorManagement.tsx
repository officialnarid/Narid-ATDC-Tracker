import React, { useState } from 'react';
import { Layers, Plus, Edit2, CheckCircle, XCircle, X, FileSpreadsheet, Download } from 'lucide-react';
import { Floor, UserRoleRecord } from '../types';
import { saveFloor } from '../services/masterService';
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

interface FloorManagementProps {
  floors: Floor[];
  onRefresh: () => void;
  currentUserRole?: UserRoleRecord | null;
  rolePermissions?: Record<string, RolePermissionRecord>;
}

export const FloorManagement: React.FC<FloorManagementProps> = ({
  floors,
  onRefresh,
  currentUserRole,
  rolePermissions,
}) => {
  const canAdd = currentUserRole
    ? hasModulePermission(currentUserRole.role, 'floors', 'add', rolePermissions)
    : true;
  const canEdit = currentUserRole
    ? hasModulePermission(currentUserRole.role, 'floors', 'edit', rolePermissions)
    : true;
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingFloor, setEditingFloor] = useState<Partial<Floor>>({
    id: '',
    name: '',
    code: '',
    order: 1,
    status: 'Active',
  });
  const [isSaving, setIsSaving] = useState(false);

  const handleOpenAdd = () => {
    setEditingFloor({
      id: `line_${Date.now()}`,
      name: '',
      code: '',
      order: floors.length + 1,
      status: 'Active',
    });
    setIsModalOpen(true);
  };

  const handleOpenEdit = (fl: Floor) => {
    setEditingFloor({ ...fl });
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingFloor.name) return;
    setIsSaving(true);
    try {
      await saveFloor(editingFloor as Floor);
      setIsModalOpen(false);
      onRefresh();
    } catch (err: any) {
      alert(`Error saving line: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (fl: Floor) => {
    const nextStatus = fl.status === 'Active' ? 'Inactive' : 'Active';
    try {
      await saveFloor({ ...fl, status: nextStatus });
      onRefresh();
    } catch (err: any) {
      alert(`Error toggling line: ${err.message}`);
    }
  };

  const bulk = useBulkSelection<Floor>({
    items: floors,
    paginatedItems: floors,
    getId: (fl) => fl.id,
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
    setBulkProgress({ label: `Exporting ${selected.length} lines...`, completed: 0, total: selected.length });
    try {
      const cols = [
        { header: 'Order', key: 'order' },
        { header: 'Line Name', key: 'name' },
        { header: 'Code', key: 'code' },
        { header: 'Status', key: 'status' },
      ];
      const rows = selected.map((fl) => ({ order: fl.order, name: fl.name, code: fl.code, status: fl.status }));
      const fn = format === 'xlsx' ? exportChunkedToExcel : exportChunkedToCsv;
      const out = await fn(rows, cols, 'Production_Lines_Selected', {
        auditTargetType: 'FLOORS',
        auditSource: 'FLOOR_MANAGEMENT',
      });
      setBulkSummary({ type: 'success', title: `Exported ${out.rowCount} Lines`, message: `Downloaded "${out.fileName}".`, savedCount: out.rowCount });
      bulk.clearSelection();
    } catch (err: any) {
      setBulkSummary({ type: 'error', title: 'Export Failed', message: err?.message || 'Unable to export lines.' });
    } finally {
      setBulkProgress(null);
      setIsBulkBusy(false);
    }
  };

  const handleBulkStatus = async () => {
    if (!pendingStatus || bulk.selectedIdArray.length === 0) return;
    setIsBulkBusy(true);
    setBulkSummary(null);
    setBulkProgress({ label: `Updating ${bulk.selectedCount} lines...`, completed: 0, total: bulk.selectedCount });
    try {
      const res = await executeMasterBulkStatus({ resource: 'floors', ids: bulk.selectedIdArray, status: pendingStatus });
      setBulkSummary({
        type: res.failedCount > 0 ? 'partial' : 'success',
        title: `Updated ${res.savedCount} Line(s)`,
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
            <Layers className="w-5 h-5 text-blue-600" />
            <span>PRODUCTION LINE MANAGEMENT</span>
          </h2>
          <p className="text-xs text-slate-500">
            Configure factory production lines (MI-01, MI-02, FATP-STB, FATP-ITR, SMT-01, etc.)
          </p>
        </div>

        {canAdd && (
          <button
            onClick={handleOpenAdd}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-1.5 shadow-sm transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add Production Line</span>
          </button>
        )}
      </div>

      <BulkActionBar
        selectedCount={bulk.selectedCount}
        totalFilteredCount={bulk.totalFilteredCount}
        currentPageCount={bulk.currentPageCount}
        isAllFilteredSelected={bulk.isAllFilteredSelected}
        isPageAllSelected={bulk.isPageAllSelected}
        recordLabel="production lines"
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
                  disabled={floors.length === 0 || isBulkBusy}
                  onChange={bulk.togglePageSelection}
                  ariaLabel="Select all production lines"
                />
              </th>
              <th className="py-3 px-4">Display Order</th>
              <th className="py-3 px-4">Line Name</th>
              <th className="py-3 px-4">Code</th>
              <th className="py-3 px-4 text-center">Status</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {floors.map(fl => {
              const isChecked = bulk.isSelected(fl.id);
              return (
              <tr key={fl.id} className={isChecked ? 'bg-blue-50/60 hover:bg-blue-50/90' : 'hover:bg-slate-50'}>
                <td className="py-3 px-3 text-center">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={isBulkBusy}
                    onChange={() => bulk.toggleOne(fl.id)}
                    aria-label={`Select line ${fl.name}`}
                    className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                  />
                </td>
                <td className="py-3 px-4 font-mono font-bold text-slate-600">#{fl.order}</td>
                <td className="py-3 px-4 font-bold text-slate-900">{fl.name}</td>
                <td className="py-3 px-4 font-mono text-slate-600">{fl.code}</td>
                <td className="py-3 px-4 text-center">
                  <button
                    onClick={() => canEdit && handleToggleStatus(fl)}
                    disabled={!canEdit}
                    className={`px-2 py-0.5 rounded text-[11px] font-bold inline-flex items-center gap-1 ${
                      fl.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {fl.status === 'Active' ? <CheckCircle className="w-3 h-3 text-emerald-600" /> : <XCircle className="w-3 h-3 text-slate-500" />}
                    <span>{fl.status}</span>
                  </button>
                </td>
                <td className="py-3 px-4 text-right">
                  {canEdit && (
                    <button
                      onClick={() => handleOpenEdit(fl)}
                      className="p-1.5 rounded hover:bg-slate-100 text-slate-700 border border-slate-200"
                      title="Edit Line"
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
                {editingFloor.name ? 'Edit Production Line' : 'Add Production Line'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="flex flex-col gap-3 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Line Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. SMT-02 or FATP-BOX"
                  value={editingFloor.name || ''}
                  onChange={(e) => setEditingFloor({ ...editingFloor, name: e.target.value })}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Code</label>
                <input
                  type="text"
                  placeholder="e.g. SMT-02"
                  value={editingFloor.code || ''}
                  onChange={(e) => setEditingFloor({ ...editingFloor, code: e.target.value.toUpperCase() })}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono uppercase"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Display Order</label>
                <input
                  type="number"
                  value={editingFloor.order || 1}
                  onChange={(e) => setEditingFloor({ ...editingFloor, order: Number(e.target.value) })}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5"
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
                  className="bg-blue-600 text-white px-4 py-1.5 rounded font-medium disabled:opacity-50"
                >
                  {isSaving ? 'Saving...' : 'Save Line'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <BulkConfirmModal
        isOpen={Boolean(pendingStatus)}
        title={pendingStatus === 'Active' ? 'Activate Selected Lines?' : 'Deactivate Selected Lines?'}
        description={`Set status to ${pendingStatus} for ${bulk.selectedCount} selected production line(s).`}
        selectedCount={bulk.selectedCount}
        confirmLabel={`${pendingStatus === 'Active' ? 'Activate' : 'Deactivate'} ${bulk.selectedCount} Line(s)`}
        tone={pendingStatus === 'Inactive' ? 'amber' : 'primary'}
        isBusy={isBulkBusy}
        onConfirm={handleBulkStatus}
        onCancel={() => !isBulkBusy && setPendingStatus(null)}
      />
    </div>
  );
};
