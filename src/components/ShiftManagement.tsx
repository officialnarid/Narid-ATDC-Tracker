import React, { useState } from 'react';
import { Clock, Plus, Edit2, CheckCircle, XCircle, X, AlertCircle } from 'lucide-react';
import { Shift } from '../types';
import { saveShift } from '../services/masterService';
import { formatMinutes } from '../services/attendanceService';
import { ShiftManagementSkeleton } from './Skeletons';

interface ShiftManagementProps {
  shifts: Shift[];
  isLoading?: boolean;
  loadError?: string | null;
  onRefresh: () => void;
}

export const ShiftManagement: React.FC<ShiftManagementProps> = ({
  shifts,
  isLoading = false,
  loadError = null,
  onRefresh,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingShift, setEditingShift] = useState<Partial<Shift>>({
    id: '',
    name: '',
    startTime: '09:00',
    endTime: '17:30',
    scheduledDurationMinutes: 510,
    punchInWindowStart: '07:30',
    punchInWindowEnd: '12:00',
    isOvernight: false,
    gracePeriodMinutes: 15,
    status: 'Active',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [togglingShiftId, setTogglingShiftId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleOpenAdd = () => {
    setEditingShift({
      id: `SHIFT_${Date.now()}`,
      name: '',
      startTime: '06:00',
      endTime: '14:30',
      scheduledDurationMinutes: 510,
      punchInWindowStart: '05:00',
      punchInWindowEnd: '08:00',
      isOvernight: false,
      gracePeriodMinutes: 15,
      status: 'Active',
    });
    setIsModalOpen(true);
  };

  const handleOpenEdit = (shift: Shift) => {
    setEditingShift({ ...shift });
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingShift.name || !editingShift.startTime || !editingShift.endTime) return;
    setIsSaving(true);
    setActionError(null);
    try {
      await saveShift(editingShift as Shift);
      setIsModalOpen(false);
      onRefresh();
    } catch (err: any) {
      setActionError(`Error saving shift: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (shift: Shift) => {
    const nextStatus = shift.status === 'Active' ? 'Inactive' : 'Active';
    setTogglingShiftId(shift.id);
    setActionError(null);
    try {
      await saveShift({ ...shift, status: nextStatus });
      onRefresh();
    } catch (err: any) {
      setActionError(`Error toggling shift: ${err.message}`);
    } finally {
      setTogglingShiftId(null);
    }
  };

  if (isLoading && shifts.length === 0 && !loadError) {
    return <ShiftManagementSkeleton />;
  }

  const effectiveError = loadError || actionError;

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      {effectiveError && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-3 text-xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{effectiveError}</span>
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
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <Clock className="w-5 h-5 text-blue-600" />
            <span>SHIFT MANAGEMENT</span>
          </h2>
          <p className="text-xs text-slate-500">
            Configure shift timings, overnight cycles, scheduled duty duration (8h30m), and scan windows
          </p>
        </div>

        <button
          onClick={handleOpenAdd}
          className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-1.5 shadow-sm transition cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Custom Shift</span>
        </button>
      </div>

      {/* Shifts Card Grid */}
      {shifts.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-xs text-slate-500 shadow-2xs">
          No shifts configured yet. Click &ldquo;Add Custom Shift&rdquo; or retry loading master configuration.
        </div>
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {shifts.map(shift => (
          <div
            key={shift.id}
            className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs flex flex-col justify-between gap-4 hover:border-blue-400 transition"
          >
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${shift.isOvernight ? 'bg-purple-600' : 'bg-blue-600'}`}></div>
                  <h3 className="font-bold text-slate-900 text-base">{shift.name}</h3>
                </div>
                <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                  shift.isOvernight ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                }`}>
                  {shift.isOvernight ? 'Overnight Shift' : 'Day Shift'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 mt-4 text-xs">
                <div>
                  <span className="text-slate-400 block text-[11px] uppercase">Shift Timing</span>
                  <span className="font-mono text-sm font-bold text-slate-800">
                    {shift.startTime} — {shift.endTime} {shift.isOvernight ? '(+1 Day)' : ''}
                  </span>
                </div>

                <div>
                  <span className="text-slate-400 block text-[11px] uppercase">Scheduled Duration</span>
                  <span className="font-mono text-sm font-bold text-emerald-700">
                    {formatMinutes(shift.scheduledDurationMinutes)}
                  </span>
                </div>

                <div>
                  <span className="text-slate-400 block text-[11px] uppercase">Punch-In Window</span>
                  <span className="font-mono text-xs font-semibold text-slate-700">
                    {shift.punchInWindowStart} to {shift.punchInWindowEnd}
                  </span>
                </div>

                <div>
                  <span className="text-slate-400 block text-[11px] uppercase">Grace Period</span>
                  <span className="font-mono text-xs font-semibold text-slate-700">
                    {shift.gracePeriodMinutes || 15} Minutes (for Late mark)
                  </span>
                </div>
              </div>

              {shift.isOvernight && (
                <div className="mt-4 p-2.5 rounded bg-purple-50 border border-purple-200 text-[11px] text-purple-900 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-purple-600 shrink-0 mt-0.5" />
                  <span>
                    <strong>Night Shift Rule:</strong> Begins 08:00 PM and ends 04:30 AM next calendar day. Attendance cycle is preserved against starting date.
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-100 text-xs">
              <button
                onClick={() => handleToggleStatus(shift)}
                disabled={togglingShiftId === shift.id}
                className={`px-2.5 py-1 rounded text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                  shift.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
                }`}
              >
                {shift.status === 'Active' ? <CheckCircle className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-slate-500" />}
                <span>{togglingShiftId === shift.id ? 'Updating...' : shift.status}</span>
              </button>

              <button
                onClick={() => handleOpenEdit(shift)}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium px-3 py-1 rounded flex items-center gap-1"
              >
                <Edit2 className="w-3 h-3" />
                <span>Edit Configuration</span>
              </button>
            </div>
          </div>
        ))}
      </div>
      )}

      {/* EDIT / CREATE MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-5 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 mb-4">
              <h3 className="font-bold text-slate-800 text-sm">
                {editingShift.name ? 'Edit Shift Configuration' : 'Add Custom Shift'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="flex flex-col gap-3 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Shift Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. MORNING SHIFT"
                  value={editingShift.name || ''}
                  onChange={(e) => setEditingShift({ ...editingShift, name: e.target.value.toUpperCase() })}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 uppercase font-semibold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Start Time (HH:mm)</label>
                  <input
                    type="time"
                    required
                    value={editingShift.startTime || '09:00'}
                    onChange={(e) => setEditingShift({ ...editingShift, startTime: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">End Time (HH:mm)</label>
                  <input
                    type="time"
                    required
                    value={editingShift.endTime || '17:30'}
                    onChange={(e) => setEditingShift({ ...editingShift, endTime: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Punch-In Window Start</label>
                  <input
                    type="time"
                    required
                    value={editingShift.punchInWindowStart || '07:30'}
                    onChange={(e) => setEditingShift({ ...editingShift, punchInWindowStart: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Punch-In Window End</label>
                  <input
                    type="time"
                    required
                    value={editingShift.punchInWindowEnd || '12:00'}
                    onChange={(e) => setEditingShift({ ...editingShift, punchInWindowEnd: e.target.value })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Scheduled Duty (Mins)</label>
                  <input
                    type="number"
                    value={editingShift.scheduledDurationMinutes || 510}
                    onChange={(e) => setEditingShift({ ...editingShift, scheduledDurationMinutes: Number(e.target.value) })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5"
                  />
                  <span className="text-[10px] text-slate-400 mt-0.5 block">510 mins = 8h 30m</span>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Grace Period (Mins)</label>
                  <input
                    type="number"
                    value={editingShift.gracePeriodMinutes || 15}
                    onChange={(e) => setEditingShift({ ...editingShift, gracePeriodMinutes: Number(e.target.value) })}
                    className="w-full border border-slate-300 rounded px-2.5 py-1.5"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="overnight-check"
                  checked={editingShift.isOvernight || false}
                  onChange={(e) => setEditingShift({ ...editingShift, isOvernight: e.target.checked })}
                  className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                />
                <label htmlFor="overnight-check" className="text-slate-800 font-semibold cursor-pointer">
                  Is Overnight Shift (Crosses midnight into next day)
                </label>
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
                  {isSaving ? 'Saving...' : 'Save Shift'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
