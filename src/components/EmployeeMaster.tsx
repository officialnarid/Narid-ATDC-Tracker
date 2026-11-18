import React, { useState, useMemo } from 'react';
import { 
  Users, 
  UserPlus, 
  Search, 
  Filter, 
  QrCode, 
  Edit3, 
  Trash2,
  AlertTriangle,
  CheckCircle, 
  XCircle, 
  Eye, 
  X, 
  RotateCcw,
  Building,
  Layers,
  Network,
  Download,
  Archive,
  FileSpreadsheet,
  Printer
} from 'lucide-react';
import { 
  Employee, 
  EmployeeType, 
  EmployeeStatus, 
  Floor, 
  Section, 
  Department 
} from '../types';
import { 
  saveEmployee, 
  toggleEmployeeStatus, 
  regenerateQrToken,
  deleteEmployee 
} from '../services/employeeService';
import { UserRoleRecord } from '../types';
import { RolePermissionRecord, hasModulePermission } from '../services/permissionService';
import { EmployeeMasterSkeleton, TableSkeletonRows } from './Skeletons';
import { useBulkSelection } from '../hooks/useBulkSelection';
import {
  BulkActionBar,
  BulkActionItem,
  BulkExecutionSummary,
  BulkProgressState,
  SelectAllCheckbox,
} from './BulkActionBar';
import { BulkConfirmModal, CrossPageSelectConfirmModal } from './BulkConfirmModal';
import {
  downloadQrIdentityCardsZip,
  executeEmployeeBulkAction,
  exportChunkedToCsv,
  exportChunkedToExcel,
} from '../services/bulkActionService';
import { EmployeeIdentityPrintCard } from './QrManagement';
import { generatePureEmployeeQrDataUrl } from '../utils/qrIdentityCard';

interface EmployeeMasterProps {
  employees: Employee[];
  floors: Floor[];
  sections: Section[];
  departments: Department[];
  isLoading?: boolean;
  loadError?: string | null;
  onRefresh: () => void;
  currentUserRole?: UserRoleRecord | null;
  rolePermissions?: Record<string, RolePermissionRecord>;
}

export const EmployeeMaster: React.FC<EmployeeMasterProps> = ({
  employees,
  floors,
  sections,
  departments,
  isLoading = false,
  loadError = null,
  onRefresh,
  currentUserRole,
  rolePermissions,
}) => {
  const canAdd = hasModulePermission(currentUserRole?.role, 'employees', 'add', rolePermissions);
  const canEdit = hasModulePermission(currentUserRole?.role, 'employees', 'edit', rolePermissions);
  const canDelete = hasModulePermission(currentUserRole?.role, 'employees', 'delete', rolePermissions);

  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [filterFloor, setFilterFloor] = useState('ALL');
  const [filterSection, setFilterSection] = useState('ALL');
  const [filterDept, setFilterDept] = useState('ALL');
  const [filterType, setFilterType] = useState('ALL');
  const [filterStatus, setFilterStatus] = useState('ALL');

  // Modal states
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [formEmployee, setFormEmployee] = useState<Partial<Employee>>({
    employeeId: '',
    employeeName: '',
    employeeType: 'Permanent',
    section: 'MI',
    department: 'Production',
    floor: '1st Floor',
    designation: 'Operator',
    employeeStatus: 'Active',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // View badge modal
  const [viewEmployee, setViewEmployee] = useState<Employee | null>(null);
  const [badgeQrUrl, setBadgeQrUrl] = useState<string | null>(null);

  // Generate QR image on demand when viewing badge
  const handleOpenBadge = async (emp: Employee) => {
    setViewEmployee(emp);
    try {
      const QRCodeMod = await import('qrcode');
      const QRCode = QRCodeMod.default || QRCodeMod;
      const qrPayload = JSON.stringify({
        employeeId: emp.employeeId,
        token: emp.qrCodeToken,
      });
      const url = await QRCode.toDataURL(qrPayload, { width: 220, margin: 2 });
      setBadgeQrUrl(url);
    } catch (e) {
      console.error('Failed to generate QR data URL:', e);
    }
  };

  const handleOpenCreate = () => {
    setIsEditing(false);
    setFormError(null);
    setFormEmployee({
      employeeId: '',
      employeeName: '',
      employeeType: 'Permanent',
      section: sections[0]?.name || 'MI',
      department: departments[0]?.name || 'Production',
      floor: floors[0]?.name || '1st Floor',
      designation: 'Operator',
      employeeStatus: 'Active',
    });
    setIsFormOpen(true);
  };

  const handleOpenEdit = (emp: Employee) => {
    setIsEditing(true);
    setFormError(null);
    setFormEmployee({ ...emp });
    setIsFormOpen(true);
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setIsSaving(true);
    try {
      await saveEmployee(formEmployee, !isEditing);
      setIsFormOpen(false);
      onRefresh();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save employee.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (emp: Employee) => {
    const nextStatus: EmployeeStatus = emp.employeeStatus === 'Active' ? 'Inactive' : 'Active';
    try {
      await toggleEmployeeStatus(emp.employeeId, nextStatus);
      onRefresh();
    } catch (err: any) {
      alert(`Error updating status: ${err.message}`);
    }
  };

  // Delete employee states & handlers
  const [employeeToDelete, setEmployeeToDelete] = useState<Employee | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleConfirmDelete = (emp: Employee | Partial<Employee>) => {
    if (!emp.employeeId) return;
    const fullEmp = employees.find(e => e.employeeId === emp.employeeId) || (emp as Employee);
    setEmployeeToDelete(fullEmp);
  };

  const handleDeleteExecution = async () => {
    if (!employeeToDelete) return;
    setIsDeleting(true);
    try {
      await deleteEmployee(employeeToDelete.employeeId);
      setEmployeeToDelete(null);
      setIsFormOpen(false);
      onRefresh();
    } catch (err: any) {
      alert(`Failed to delete employee: ${err.message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRegenerateToken = async (employeeId: string) => {
    if (!confirm(`Are you sure you want to regenerate the QR token for ${employeeId}? Old QR code will be invalidated.`)) return;
    try {
      await regenerateQrToken(employeeId);
      onRefresh();
      if (viewEmployee && viewEmployee.employeeId === employeeId) {
        const updated = employees.find(e => e.employeeId === employeeId);
        if (updated) handleOpenBadge(updated);
      }
    } catch (err: any) {
      alert(`Error regenerating token: ${err.message}`);
    }
  };

  const activeCount = useMemo(
    () => employees.filter(e => e.employeeStatus === 'Active').length,
    [employees]
  );

  // Filtered employees list
  const filteredList = useMemo(() => {
    const s = searchTerm.trim().toLowerCase();
    return employees.filter(emp => {
      if (s !== '') {
        if (
          !emp.employeeId.toLowerCase().includes(s) &&
          !emp.employeeName.toLowerCase().includes(s) &&
          !emp.designation.toLowerCase().includes(s)
        ) {
          return false;
        }
      }
      if (filterFloor !== 'ALL' && emp.floor !== filterFloor) return false;
      if (filterSection !== 'ALL' && emp.section !== filterSection) return false;
      if (filterDept !== 'ALL' && emp.department !== filterDept) return false;
      if (filterType !== 'ALL' && emp.employeeType !== filterType) return false;
      if (filterStatus !== 'ALL' && emp.employeeStatus !== filterStatus) return false;
      return true;
    });
  }, [employees, searchTerm, filterFloor, filterSection, filterDept, filterType, filterStatus]);

  const totalPages = Math.max(1, Math.ceil(filteredList.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginatedList = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredList.slice(start, start + pageSize);
  }, [filteredList, safePage, pageSize]);

  // Global Bulk Selection & Batch Action state
  const bulk = useBulkSelection<Employee>({
    items: filteredList,
    paginatedItems: paginatedList,
    getId: (emp) => emp.employeeId,
  });

  const [bulkProgress, setBulkProgress] = useState<BulkProgressState | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkExecutionSummary | null>(null);
  const [bulkPendingAction, setBulkPendingAction] = useState<'ACTIVATE' | 'DEACTIVATE' | 'DELETE' | null>(null);
  const [isBulkExecuting, setIsBulkExecuting] = useState(false);
  const [retryFailedState, setRetryFailedState] = useState<{
    kind: 'zip' | 'ACTIVATE' | 'DEACTIVATE' | 'DELETE';
    ids: string[];
  } | null>(null);

  const [isBulkPrintOpen, setIsBulkPrintOpen] = useState(false);
  const [bulkPrintQrMap, setBulkPrintQrMap] = useState<Record<string, string>>({});
  const [isGeneratingPrintQrs, setIsGeneratingPrintQrs] = useState(false);

  const selectedEmployees = useMemo(() => bulk.selectedItems, [bulk.selectedItems]);

  const EMPLOYEE_EXPORT_COLUMNS = [
    { header: 'Employee ID', key: 'employeeId' },
    { header: 'Employee Name', key: 'employeeName' },
    { header: 'Type', key: 'employeeType' },
    { header: 'Line', key: 'floor' },
    { header: 'Section', key: 'section' },
    { header: 'Department', key: 'department' },
    { header: 'Designation', key: 'designation' },
    { header: 'Status', key: 'employeeStatus' },
  ];

  const handleBulkExport = async (format: 'xlsx' | 'csv') => {
    const target = selectedEmployees;
    if (target.length === 0 || isBulkExecuting) return;
    setIsBulkExecuting(true);
    setBulkSummary(null);
    setRetryFailedState(null);
    setBulkProgress({
      label: format === 'xlsx' ? 'Exporting selected employees to Excel...' : 'Exporting selected employees to CSV...',
      completed: 0,
      total: target.length,
    });
    try {
      const exportRows = target.map((e) => ({
        employeeId: e.employeeId,
        employeeName: e.employeeName,
        employeeType: e.employeeType,
        floor: e.floor,
        section: e.section,
        department: e.department,
        designation: e.designation,
        employeeStatus: e.employeeStatus,
      }));
      const fn = format === 'xlsx' ? exportChunkedToExcel : exportChunkedToCsv;
      const out = await fn(exportRows, EMPLOYEE_EXPORT_COLUMNS, 'Employees_Selected', {
        onProgress: (completed, total) =>
          setBulkProgress({
            label: format === 'xlsx' ? 'Exporting selected employees to Excel...' : 'Exporting selected employees to CSV...',
            completed,
            total,
          }),
        auditTargetType: 'EMPLOYEES',
        auditSource: 'EMPLOYEE_MASTER',
        auditDescription: `Bulk exported ${exportRows.length} selected employees to ${format.toUpperCase()}.`,
      });
      setBulkSummary({
        type: 'success',
        title: `Exported ${out.rowCount} Employees`,
        message: `Downloaded "${out.fileName}". Selection cleared.`,
        savedCount: out.rowCount,
      });
      bulk.clearSelection();
    } catch (err: any) {
      setBulkSummary({
        type: 'error',
        title: 'Bulk Export Failed',
        message: err?.message || 'Unable to export selected employees.',
      });
    } finally {
      setBulkProgress(null);
      setIsBulkExecuting(false);
    }
  };

  const handleBulkDownloadZip = async (overrideIds?: string[]) => {
    const targets = overrideIds
      ? employees.filter((e) => overrideIds.includes(e.employeeId))
      : selectedEmployees;
    if (targets.length === 0 || isBulkExecuting) return;

    setIsBulkExecuting(true);
    setBulkSummary(null);
    setRetryFailedState(null);
    setBulkProgress({
      label: 'Generating Employee QR Identity Card ZIP...',
      completed: 0,
      total: targets.length,
    });

    try {
      const { result } = await downloadQrIdentityCardsZip(targets, {
        auditSource: 'EMPLOYEE_MASTER',
        onProgress: ({ completed, total, currentEmployeeId }) => {
          setBulkProgress({
            label: 'Generating Employee QR Identity Card ZIP...',
            completed,
            total,
            detail: currentEmployeeId ? `Rendering card: ${currentEmployeeId}` : undefined,
          });
        },
      });

      const failedIds = result.failedItems.map((f) => f.employeeId);
      if (failedIds.length > 0) {
        setRetryFailedState({ kind: 'zip', ids: failedIds });
        bulk.setSelectedIdList(failedIds);
        setBulkSummary({
          type: result.exportedCount > 0 ? 'partial' : 'error',
          title:
            result.exportedCount > 0
              ? 'QR Card ZIP Generated with Partial Failures'
              : 'QR Card ZIP Generation Failed',
          message:
            result.fileName
              ? `Downloaded "${result.fileName}". ${failedIds.length} card(s) failed.`
              : 'Failed to generate QR identity cards for selected employees.',
          savedCount: result.exportedCount,
          skippedCount: result.skippedIds.length,
          failedCount: failedIds.length,
          canRetryFailed: true,
        });
      } else {
        setBulkSummary({
          type: result.skippedIds.length > 0 ? 'partial' : 'success',
          title: `QR Card ZIP Ready (${result.exportedCount} Cards)`,
          message: result.fileName
            ? `Downloaded "${result.fileName}" preserving existing employee QR tokens.`
            : 'No eligible QR tokens found in selection.',
          savedCount: result.exportedCount,
          skippedCount: result.skippedIds.length,
        });
        bulk.clearSelection();
      }
    } catch (err: any) {
      setBulkSummary({
        type: 'error',
        title: 'Bulk QR ZIP Failed',
        message: err?.message || 'Unable to package Employee QR Identity Cards.',
      });
    } finally {
      setBulkProgress(null);
      setIsBulkExecuting(false);
    }
  };

  const handleOpenBulkPrintModal = async () => {
    const targets = selectedEmployees;
    if (targets.length === 0 || isBulkExecuting) return;
    setIsBulkPrintOpen(true);
    setIsGeneratingPrintQrs(true);
    const nextMap: Record<string, string> = {};
    try {
      const CHUNK = 8;
      for (let i = 0; i < targets.length; i += CHUNK) {
        const chunk = targets.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map(async (emp) => {
            if (!emp.qrCodeToken) return;
            try {
              nextMap[emp.employeeId] = await generatePureEmployeeQrDataUrl(emp, 240);
            } catch {
              // ignore individual QR render error
            }
          })
        );
      }
      setBulkPrintQrMap(nextMap);
    } finally {
      setIsGeneratingPrintQrs(false);
    }
  };

  const handleExecuteBulkMutation = async (
    actionOverride?: 'ACTIVATE' | 'DEACTIVATE' | 'DELETE',
    overrideIds?: string[]
  ) => {
    const action = actionOverride || bulkPendingAction;
    if (!action) return;
    const ids = overrideIds || bulk.selectedIdArray;
    if (ids.length === 0) return;

    setIsBulkExecuting(true);
    setBulkSummary(null);
    setRetryFailedState(null);
    setBulkProgress({
      label:
        action === 'DELETE'
          ? 'Deleting eligible employees...'
          : action === 'ACTIVATE'
            ? 'Activating selected employees...'
            : 'Deactivating selected employees...',
      completed: 0,
      total: ids.length,
      detail: `Submitting ${ids.length} employees in verified batch chunks...`,
    });

    try {
      const res = await executeEmployeeBulkAction({
        action,
        employeeIds: ids,
        confirmPhrase: action === 'DELETE' ? 'DELETE' : undefined,
      });

      setBulkProgress({
        label: 'Completed',
        completed: ids.length,
        total: ids.length,
      });

      const failedIds = (res.failedItems || []).map((f) => f.id);
      const skippedSummary =
        res.skippedItems && res.skippedItems.length > 0
          ? ` ${res.skippedItems[0].reason || 'Some employees were skipped to preserve attendance integrity.'}`
          : '';

      if (failedIds.length > 0) {
        setRetryFailedState({ kind: action, ids: failedIds });
        bulk.setSelectedIdList(failedIds);
        setBulkSummary({
          type: res.savedCount > 0 ? 'partial' : 'error',
          title: `Bulk ${action} Partially Completed`,
          message: `${res.savedCount} updated, ${res.failedCount} failed.${skippedSummary}`,
          savedCount: res.savedCount,
          skippedCount: res.skippedCount,
          failedCount: res.failedCount,
          canRetryFailed: true,
        });
      } else {
        setBulkSummary({
          type: res.skippedCount > 0 ? 'partial' : 'success',
          title: `Bulk ${action === 'ACTIVATE' ? 'Activation' : action === 'DEACTIVATE' ? 'Deactivation' : 'Deletion'} Complete`,
          message:
            action === 'DELETE'
              ? `Deleted ${res.savedCount} employee(s).${skippedSummary}`
              : `Updated ${res.savedCount} employee record(s).${skippedSummary}`,
          savedCount: res.savedCount,
          skippedCount: res.skippedCount,
        });
        bulk.clearSelection();
      }
      setBulkPendingAction(null);
      onRefresh();
    } catch (err: any) {
      setBulkSummary({
        type: 'error',
        title: `Bulk ${action} Blocked`,
        message: err?.message || 'Permission or validation error while processing bulk action.',
      });
    } finally {
      setBulkProgress(null);
      setIsBulkExecuting(false);
    }
  };

  const bulkActionItems: BulkActionItem[] = [
    {
      id: 'export_excel',
      label: 'Export Excel',
      icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
      tone: 'emerald',
      onClick: () => handleBulkExport('xlsx'),
    },
    {
      id: 'export_csv',
      label: 'Export CSV',
      icon: <Download className="w-3.5 h-3.5" />,
      tone: 'default',
      onClick: () => handleBulkExport('csv'),
    },
    {
      id: 'qr_zip',
      label: 'Download QR ZIP',
      icon: <Archive className="w-3.5 h-3.5" />,
      tone: 'primary',
      onClick: () => handleBulkDownloadZip(),
    },
    {
      id: 'print_qr',
      label: 'Print QR ID Cards',
      icon: <Printer className="w-3.5 h-3.5" />,
      tone: 'default',
      onClick: handleOpenBulkPrintModal,
    },
    {
      id: 'bulk_activate',
      label: 'Activate',
      icon: <CheckCircle className="w-3.5 h-3.5" />,
      tone: 'emerald',
      hidden: !canEdit,
      onClick: () => setBulkPendingAction('ACTIVATE'),
    },
    {
      id: 'bulk_deactivate',
      label: 'Deactivate',
      icon: <XCircle className="w-3.5 h-3.5" />,
      tone: 'amber',
      hidden: !canEdit,
      onClick: () => setBulkPendingAction('DEACTIVATE'),
    },
    {
      id: 'bulk_delete',
      label: 'Delete Selected',
      icon: <Trash2 className="w-3.5 h-3.5" />,
      tone: 'danger',
      hidden: !canDelete,
      onClick: () => setBulkPendingAction('DELETE'),
    },
  ];

  if (isLoading && employees.length === 0 && !loadError) {
    return <EmployeeMasterSkeleton />;
  }

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {loadError && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{loadError}</span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="bg-white hover:bg-red-100 text-red-700 border border-red-300 px-3 py-1 rounded font-semibold transition cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}
      {/* Top Header & Action */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <Users className="w-5 h-5 text-blue-600" />
            <span>EMPLOYEE MASTER</span>
            {isLoading && employees.length > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 ml-2">
                <RotateCcw className="w-3 h-3 animate-spin" />
                Refreshing
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-500">
            Total {employees.length} records • {activeCount} Active
          </p>
        </div>

        {canAdd && (
          <button
            onClick={handleOpenCreate}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-1.5 transition shadow-sm self-start md:self-auto cursor-pointer"
          >
            <UserPlus className="w-4 h-4" />
            <span>Add New Employee</span>
          </button>
        )}
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs flex flex-wrap items-center gap-3 text-xs">
        {/* Search */}
        <div className="flex items-center gap-2 bg-slate-50 border border-slate-300 rounded px-2.5 py-1.5 flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search by Employee ID, Name or Designation..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-transparent border-none text-slate-800 focus:outline-hidden"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="text-slate-400 hover:text-slate-600">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Line Filter */}
        <select
          value={filterFloor}
          onChange={(e) => setFilterFloor(e.target.value)}
          className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
        >
          <option value="ALL">All Lines</option>
          {floors.map(f => <option key={f.id} value={f.name}>{f.name}</option>)}
        </select>

        {/* Section Filter */}
        <select
          value={filterSection}
          onChange={(e) => setFilterSection(e.target.value)}
          className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
        >
          <option value="ALL">All Sections</option>
          {sections.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>

        {/* Department Filter */}
        <select
          value={filterDept}
          onChange={(e) => setFilterDept(e.target.value)}
          className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
        >
          <option value="ALL">All Departments</option>
          {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>

        {/* Type Filter */}
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
        >
          <option value="ALL">All Types</option>
          <option value="Permanent">Permanent</option>
          <option value="Staff">Staff</option>
          <option value="Offroll">Offroll</option>
        </select>

        {/* Status Filter */}
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="bg-white border border-slate-300 rounded px-2 py-1.5 text-slate-700"
        >
          <option value="ALL">All Status</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
        </select>

        {(searchTerm || filterFloor !== 'ALL' || filterSection !== 'ALL' || filterDept !== 'ALL' || filterType !== 'ALL' || filterStatus !== 'ALL') && (
          <button
            onClick={() => {
              setSearchTerm('');
              setFilterFloor('ALL');
              setFilterSection('ALL');
              setFilterDept('ALL');
              setFilterType('ALL');
              setFilterStatus('ALL');
            }}
            className="text-blue-600 hover:text-blue-800 font-medium text-xs px-2 py-1"
          >
            Reset Filters
          </button>
        )}
      </div>

      {/* Global Bulk Action Toolbar */}
      <BulkActionBar
        selectedCount={bulk.selectedCount}
        totalFilteredCount={bulk.totalFilteredCount}
        currentPageCount={bulk.currentPageCount}
        isAllFilteredSelected={bulk.isAllFilteredSelected}
        isPageAllSelected={bulk.isPageAllSelected}
        recordLabel="employees"
        actions={bulkActionItems}
        onSelectAllFiltered={bulk.requestSelectAllFiltered}
        onClearSelection={bulk.clearSelection}
        progress={bulkProgress}
        summary={bulkSummary}
        onDismissSummary={() => setBulkSummary(null)}
        onRetryFailed={
          retryFailedState
            ? () => {
                if (retryFailedState.kind === 'zip') {
                  handleBulkDownloadZip(retryFailedState.ids);
                } else {
                  handleExecuteBulkMutation(retryFailedState.kind, retryFailedState.ids);
                }
              }
            : undefined
        }
      />

      {/* Employees Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
              <tr>
                <th className="py-3 px-3 w-10 text-center">
                  <SelectAllCheckbox
                    checked={bulk.isPageAllSelected}
                    indeterminate={bulk.isPageIndeterminate}
                    disabled={paginatedList.length === 0 || isBulkExecuting}
                    onChange={bulk.togglePageSelection}
                    ariaLabel="Select all employees on current page"
                  />
                </th>
                <th className="py-3 px-3.5">Employee ID</th>
                <th className="py-3 px-3.5">Employee Name</th>
                <th className="py-3 px-3.5">Type</th>
                <th className="py-3 px-3.5">Line</th>
                <th className="py-3 px-3.5">Section</th>
                <th className="py-3 px-3.5">Department</th>
                <th className="py-3 px-3.5">Designation</th>
                <th className="py-3 px-3.5 text-center">Status</th>
                <th className="py-3 px-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading && filteredList.length === 0 ? (
                <TableSkeletonRows rows={6} cols={10} />
              ) : filteredList.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-slate-400">
                    No employees matching the criteria found.
                  </td>
                </tr>
              ) : (
                paginatedList.map((emp) => {
                  const isChecked = bulk.isSelected(emp.employeeId);
                  return (
                  <tr
                    key={emp.employeeId}
                    className={`transition ${isChecked ? 'bg-blue-50/60 hover:bg-blue-50/90' : 'hover:bg-slate-50/70'}`}
                  >
                    <td className="py-3 px-3 text-center">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={isBulkExecuting}
                        onChange={() => bulk.toggleOne(emp.employeeId)}
                        aria-label={`Select employee ${emp.employeeId}`}
                        className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                      />
                    </td>
                    <td className="py-3 px-3.5 font-mono font-bold text-slate-900">{emp.employeeId}</td>
                    <td className="py-3 px-3.5 font-semibold text-slate-800">{emp.employeeName}</td>
                    <td className="py-3 px-3.5">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                        emp.employeeType === 'Permanent' ? 'bg-blue-100 text-blue-800' :
                        emp.employeeType === 'Staff' ? 'bg-purple-100 text-purple-800' :
                        'bg-amber-100 text-amber-800'
                      }`}>
                        {emp.employeeType}
                      </span>
                    </td>
                    <td className="py-3 px-3.5 text-slate-600">{emp.floor}</td>
                    <td className="py-3 px-3.5 text-slate-600">{emp.section}</td>
                    <td className="py-3 px-3.5 text-slate-600">{emp.department}</td>
                    <td className="py-3 px-3.5 text-slate-600">{emp.designation}</td>
                    <td className="py-3 px-3.5 text-center">
                      <button
                        onClick={() => handleToggleStatus(emp)}
                        title="Click to toggle Active/Inactive"
                        className={`px-2 py-0.5 rounded text-[11px] font-bold inline-flex items-center gap-1 cursor-pointer transition ${
                          emp.employeeStatus === 'Active'
                            ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                            : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                        }`}
                      >
                        {emp.employeeStatus === 'Active' ? (
                          <>
                            <CheckCircle className="w-3 h-3 text-emerald-600" />
                            <span>Active</span>
                          </>
                        ) : (
                          <>
                            <XCircle className="w-3 h-3 text-slate-500" />
                            <span>Inactive</span>
                          </>
                        )}
                      </button>
                    </td>
                    <td className="py-3 px-3.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleOpenBadge(emp)}
                          className="p-1.5 rounded hover:bg-blue-50 text-blue-600 border border-slate-200 cursor-pointer"
                          title="View ID Badge & QR Code"
                        >
                          <QrCode className="w-3.5 h-3.5" />
                        </button>
                        {canEdit && (
                          <button
                            onClick={() => handleOpenEdit(emp)}
                            className="p-1.5 rounded hover:bg-slate-100 text-slate-700 border border-slate-200 cursor-pointer"
                            title="Edit Employee"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {canDelete && (
                          <button
                            onClick={() => handleConfirmDelete(emp)}
                            className="p-1.5 rounded hover:bg-red-50 text-red-600 border border-slate-200 transition cursor-pointer"
                            title="Delete Employee"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {filteredList.length > 0 && (
          <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
            <div>
              Showing <span className="font-semibold text-slate-800">{(safePage - 1) * pageSize + 1}</span>–
              <span className="font-semibold text-slate-800">{Math.min(safePage * pageSize, filteredList.length)}</span> of{' '}
              <span className="font-semibold text-slate-800">{filteredList.length}</span> employees
            </div>
            <div className="flex items-center gap-2">
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="Rows per page"
                className="bg-white border border-slate-300 rounded px-2 py-1 text-xs"
              >
                <option value={25}>25 / page</option>
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
              </select>
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
              >
                Prev
              </button>
              <span className="font-mono text-[11px]">
                {safePage} / {totalPages}
              </span>
              <button
                type="button"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* CREATE / EDIT EMPLOYEE MODAL */}
      {isFormOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                {isEditing ? `Edit Employee (${formEmployee.employeeId})` : 'Add New Employee'}
              </h3>
              <button
                onClick={() => setIsFormOpen(false)}
                className="p-1 rounded hover:bg-slate-100 text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveForm} className="p-5 flex flex-col gap-4 text-xs">
              {formError && (
                <div className="bg-red-50 text-red-800 p-2.5 rounded border border-red-200">
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">
                    Employee ID <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    disabled={isEditing}
                    placeholder="e.g. JMD12345"
                    value={formEmployee.employeeId || ''}
                    onChange={(e) => setFormEmployee({ ...formEmployee, employeeId: e.target.value.toUpperCase() })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono text-xs uppercase disabled:bg-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">
                    Employee Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. RAHUL SHARMA"
                    value={formEmployee.employeeName || ''}
                    onChange={(e) => setFormEmployee({ ...formEmployee, employeeName: e.target.value.toUpperCase() })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs uppercase"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Employee Type</label>
                  <select
                    value={formEmployee.employeeType || 'Permanent'}
                    onChange={(e) => setFormEmployee({ ...formEmployee, employeeType: e.target.value as EmployeeType })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  >
                    <option value="Permanent">Permanent</option>
                    <option value="Staff">Staff</option>
                    <option value="Offroll">Offroll</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Designation</label>
                  <input
                    type="text"
                    placeholder="e.g. Machine Operator"
                    value={formEmployee.designation || ''}
                    onChange={(e) => setFormEmployee({ ...formEmployee, designation: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Production Line *</label>
                  <select
                    value={formEmployee.floor || floors[0]?.name}
                    onChange={(e) => setFormEmployee({ ...formEmployee, floor: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs font-semibold"
                  >
                    {floors.map(f => <option key={f.id} value={f.name}>{f.name}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Section</label>
                  <select
                    value={formEmployee.section || sections[0]?.name}
                    onChange={(e) => setFormEmployee({ ...formEmployee, section: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs"
                  >
                    {sections.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Department</label>
                  <select
                    value={formEmployee.department || departments[0]?.name}
                    onChange={(e) => setFormEmployee({ ...formEmployee, department: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-xs"
                  >
                    {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Status</label>
                <select
                  value={formEmployee.employeeStatus || 'Active'}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === 'DELETE') {
                      handleConfirmDelete(formEmployee as Employee);
                    } else {
                      setFormEmployee({ ...formEmployee, employeeStatus: val as EmployeeStatus });
                    }
                  }}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-medium"
                >
                  <option value="Active">Active (Eligible for attendance)</option>
                  <option value="Inactive">Inactive (Attendance blocked)</option>
                  {isEditing && (
                    <option value="DELETE" className="text-red-600 font-bold">
                      🗑️ Delete Employee (Permanently remove record)
                    </option>
                  )}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  Active allows QR punches; Inactive blocks gate scans; Delete permanently removes the employee from database.
                </p>
              </div>

              <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-100">
                {isEditing ? (
                  <button
                    type="button"
                    onClick={() => handleConfirmDelete(formEmployee as Employee)}
                    className="bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 px-3 py-1.5 rounded font-medium text-xs flex items-center gap-1.5 transition cursor-pointer"
                    title="Permanently remove employee"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-600" />
                    <span>Delete Employee</span>
                  </button>
                ) : <div />}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsFormOpen(false)}
                    className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded font-medium disabled:opacity-50"
                  >
                    {isSaving ? 'Saving...' : isEditing ? 'Update Employee' : 'Create Employee'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* VIEW ID BADGE & QR MODAL */}
      {viewEmployee && badgeQrUrl && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
            <div className="bg-blue-900 text-white p-4 flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-blue-200">Factory Identity Card</div>
                <h4 className="font-bold text-sm tracking-wide">Narid ATDC Tracker</h4>
              </div>
              <button
                onClick={() => setViewEmployee(null)}
                className="p-1 rounded hover:bg-blue-800 text-blue-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Printable ID card body */}
            <div className="p-6 flex flex-col items-center text-center">
              <div className="w-44 h-44 bg-white p-2 rounded-xl border border-slate-200 shadow-inner flex items-center justify-center mb-4">
                <img src={badgeQrUrl} alt="QR Code" className="w-full h-full object-contain" />
              </div>

              <div className="font-mono text-lg font-black text-slate-900 tracking-wider">
                {viewEmployee.employeeId}
              </div>
              <div className="text-base font-bold text-slate-800 mt-0.5">
                {viewEmployee.employeeName}
              </div>
              <div className="text-xs text-blue-600 font-semibold mt-0.5">
                {viewEmployee.designation}
              </div>

              <div className="w-full border-t border-slate-200 my-4 pt-3 grid grid-cols-3 gap-1 text-[11px] text-slate-600">
                <div>
                  <span className="text-[10px] text-slate-400 block uppercase">Line</span>
                  <span className="font-bold text-slate-800">{viewEmployee.floor}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block uppercase">Section</span>
                  <span className="font-bold text-slate-800">{viewEmployee.section}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block uppercase">Department</span>
                  <span className="font-bold text-slate-800">{viewEmployee.department}</span>
                </div>
              </div>

              <div className="flex items-center gap-2 mt-2 w-full">
                <a
                  href={badgeQrUrl}
                  download={`QR_${viewEmployee.employeeId}.png`}
                  className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs py-2 rounded font-medium flex items-center justify-center gap-1.5 transition"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download QR</span>
                </a>
                <button
                  onClick={() => handleRegenerateToken(viewEmployee.employeeId)}
                  className="bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 text-xs px-3 py-2 rounded font-medium flex items-center gap-1 transition"
                  title="Revoke and generate new QR token"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reissue</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {employeeToDelete && (
        <div className="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-5 shadow-2xl border border-red-100">
            <div className="flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-full bg-red-100 border border-red-200 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-bold text-slate-900">
                  Delete Employee Record?
                </h3>
                <p className="text-xs text-slate-600 mt-1">
                  Are you sure you want to permanently delete this employee? This will remove their profile and QR code from the database.
                </p>

                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 mt-3 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-500 font-medium">Employee ID:</span>
                    <span className="font-mono font-bold text-slate-800">{employeeToDelete.employeeId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500 font-medium">Name:</span>
                    <span className="font-bold text-slate-800">{employeeToDelete.employeeName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500 font-medium">Line:</span>
                    <span className="text-slate-700">{employeeToDelete.floor}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500 font-medium">Department:</span>
                    <span className="text-slate-700">{employeeToDelete.department}</span>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2.5 mt-5">
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={() => setEmployeeToDelete(null)}
                    className="px-3.5 py-1.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium text-xs transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={handleDeleteExecution}
                    className="px-4 py-1.5 rounded bg-red-600 hover:bg-red-700 text-white font-semibold text-xs flex items-center gap-1.5 shadow-sm transition disabled:opacity-50 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isDeleting ? 'Deleting...' : 'Yes, Delete Employee'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* BULK PRINT QR IDENTITY CARDS MODAL */}
      {isBulkPrintOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 qr-print-overlay">
          <style>{`
            @media print {
              body * {
                visibility: hidden !important;
              }
              #print-sheet-area,
              #print-sheet-area * {
                visibility: visible !important;
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
              }
              #print-sheet-area {
                position: fixed !important;
                inset: 0 !important;
                width: 100% !important;
                height: auto !important;
                overflow: visible !important;
                background: #ffffff !important;
                padding: 8mm !important;
              }
              .qr-identity-print-card {
                break-inside: avoid !important;
                page-break-inside: avoid !important;
              }
            }
          `}</style>
          <div className="bg-white rounded-xl max-w-5xl w-full max-h-[90vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-900 text-white">
              <div>
                <h3 className="text-base font-bold">Bulk Print Employee QR ID Cards</h3>
                <p className="text-xs text-slate-400">
                  {isGeneratingPrintQrs
                    ? `Preparing QR badges for ${selectedEmployees.length} selected employees...`
                    : `Ready to print ${selectedEmployees.length} employee identity ${selectedEmployees.length === 1 ? 'card' : 'cards'} preserving existing tokens`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={isGeneratingPrintQrs}
                  onClick={() => window.print()}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-1.5 shadow disabled:opacity-50 cursor-pointer"
                >
                  <Printer className="w-4 h-4" />
                  <span>Send to Printer (A4 Sheet)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsBulkPrintOpen(false)}
                  className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white cursor-pointer"
                  aria-label="Close Bulk Print Preview"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 flex-1 overflow-y-auto bg-slate-100" id="print-sheet-area">
              <div
                className={`grid gap-4 bg-white p-6 rounded shadow-sm border border-slate-200 ${
                  selectedEmployees.length === 1
                    ? 'grid-cols-1 max-w-xs mx-auto'
                    : 'grid-cols-2 md:grid-cols-3'
                }`}
              >
                {selectedEmployees.map((emp) => (
                  <EmployeeIdentityPrintCard
                    key={emp.employeeId}
                    employee={emp}
                    qrUrl={bulkPrintQrMap[emp.employeeId]}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* BULK STATUS / DELETE CONFIRMATION MODAL */}
      <BulkConfirmModal
        isOpen={Boolean(bulkPendingAction)}
        title={
          bulkPendingAction === 'DELETE'
            ? 'Bulk Delete Selected Employees?'
            : bulkPendingAction === 'ACTIVATE'
              ? 'Bulk Activate Selected Employees?'
              : 'Bulk Deactivate Selected Employees?'
        }
        description={
          bulkPendingAction === 'DELETE'
            ? `You are about to permanently remove ${bulk.selectedCount} selected employee profile(s). Employees with historical attendance records will be automatically protected and skipped to preserve attendance integrity.`
            : bulkPendingAction === 'ACTIVATE'
              ? `Set status to Active for ${bulk.selectedCount} selected employee(s). Existing QR tokens and employee IDs remain intact.`
              : `Set status to Inactive for ${bulk.selectedCount} selected employee(s). Gate QR scanning is paused while Inactive, and all tokens & historical attendance remain preserved.`
        }
        selectedCount={bulk.selectedCount}
        confirmLabel={
          bulkPendingAction === 'DELETE'
            ? `Delete ${bulk.selectedCount} Eligible`
            : bulkPendingAction === 'ACTIVATE'
              ? `Activate ${bulk.selectedCount} Employees`
              : `Deactivate ${bulk.selectedCount} Employees`
        }
        tone={bulkPendingAction === 'DELETE' ? 'danger' : bulkPendingAction === 'DEACTIVATE' ? 'amber' : 'primary'}
        warningDetails={
          bulkPendingAction === 'DELETE'
            ? [
                'Employees with existing attendance records are automatically skipped and preserved.',
                'All batch deletions are permanently recorded in Enterprise Audit Logs.',
              ]
            : ['Existing Employee IDs, QR tokens, and attendance history remain completely unchanged.']
        }
        requireConfirmPhrase={bulkPendingAction === 'DELETE' ? 'DELETE' : undefined}
        isBusy={isBulkExecuting}
        onConfirm={() => handleExecuteBulkMutation()}
        onCancel={() => {
          if (!isBulkExecuting) setBulkPendingAction(null);
        }}
      />

      <CrossPageSelectConfirmModal
        isOpen={bulk.isCrossPageConfirmOpen}
        totalFilteredCount={bulk.totalFilteredCount}
        currentPageCount={bulk.currentPageCount}
        recordLabel="employees"
        onConfirm={bulk.confirmSelectAllFiltered}
        onCancel={bulk.cancelSelectAllFiltered}
      />
    </div>
  );
};
