import React, { useState } from 'react';
import { Network, Plus, Edit2, CheckCircle, XCircle, X } from 'lucide-react';
import { Section, Floor } from '../types';
import { saveSection } from '../services/masterService';

interface SectionManagementProps {
  sections: Section[];
  floors: Floor[];
  onRefresh: () => void;
}

export const SectionManagement: React.FC<SectionManagementProps> = ({
  sections,
  floors,
  onRefresh,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSection, setEditingSection] = useState<Partial<Section>>({
    id: '',
    name: '',
    code: '',
    floorId: floors[0]?.id || '',
    status: 'Active',
  });
  const [isSaving, setIsSaving] = useState(false);

  const handleOpenAdd = () => {
    setEditingSection({
      id: `sec_${Date.now()}`,
      name: '',
      code: '',
      floorId: floors[0]?.id || '',
      status: 'Active',
    });
    setIsModalOpen(true);
  };

  const handleOpenEdit = (sec: Section) => {
    setEditingSection({ ...sec });
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSection.name) return;
    setIsSaving(true);
    try {
      await saveSection(editingSection as Section);
      setIsModalOpen(false);
      onRefresh();
    } catch (err: any) {
      alert(`Error saving section: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (sec: Section) => {
    const nextStatus = sec.status === 'Active' ? 'Inactive' : 'Active';
    try {
      await saveSection({ ...sec, status: nextStatus });
      onRefresh();
    } catch (err: any) {
      alert(`Error toggling section: ${err.message}`);
    }
  };

  return (
    <div className="p-6 bg-slate-50 min-h-full flex flex-col gap-6">
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <Network className="w-5 h-5 text-indigo-600" />
            <span>SECTION MANAGEMENT</span>
          </h2>
          <p className="text-xs text-slate-500">
            Configure plant sections (MI, SMT, FATP, STORE, etc.)
          </p>
        </div>

        <button
          onClick={handleOpenAdd}
          className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-xs px-4 py-2 rounded flex items-center gap-1.5 shadow-sm transition"
        >
          <Plus className="w-4 h-4" />
          <span>Add Section</span>
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
            <tr>
              <th className="py-3 px-4">Section Name</th>
              <th className="py-3 px-4">Code</th>
              <th className="py-3 px-4 text-center">Status</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sections.map(sec => (
              <tr key={sec.id} className="hover:bg-slate-50">
                <td className="py-3 px-4 font-bold text-slate-900">{sec.name}</td>
                <td className="py-3 px-4 font-mono text-slate-600">{sec.code}</td>
                <td className="py-3 px-4 text-center">
                  <button
                    onClick={() => handleToggleStatus(sec)}
                    className={`px-2 py-0.5 rounded text-[11px] font-bold inline-flex items-center gap-1 ${
                      sec.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {sec.status === 'Active' ? <CheckCircle className="w-3 h-3 text-emerald-600" /> : <XCircle className="w-3 h-3 text-slate-500" />}
                    <span>{sec.status}</span>
                  </button>
                </td>
                <td className="py-3 px-4 text-right">
                  <button
                    onClick={() => handleOpenEdit(sec)}
                    className="p-1.5 rounded hover:bg-slate-100 text-slate-700 border border-slate-200"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-sm w-full p-5 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 mb-4">
              <h3 className="font-bold text-slate-800 text-sm">
                {editingSection.name ? 'Edit Section' : 'Add Section'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="flex flex-col gap-3 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Section Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. SMT"
                  value={editingSection.name || ''}
                  onChange={(e) => setEditingSection({ ...editingSection, name: e.target.value.toUpperCase() })}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 uppercase font-semibold"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Code</label>
                <input
                  type="text"
                  placeholder="e.g. SMT"
                  value={editingSection.code || ''}
                  onChange={(e) => setEditingSection({ ...editingSection, code: e.target.value.toUpperCase() })}
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
                  className="bg-indigo-600 text-white px-4 py-1.5 rounded font-medium disabled:opacity-50"
                >
                  {isSaving ? 'Saving...' : 'Save Section'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
