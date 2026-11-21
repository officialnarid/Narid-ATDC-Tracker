import React from 'react';
import { Employee } from '../types';
import { IDENTITY_CARD_HEADER_TEXT } from '../utils/qrIdentityCard';

export interface EmployeeQrCardProps {
  employee: Employee;
  qrUrl?: string;
}

export type EmployeeIdentityPrintCardProps = EmployeeQrCardProps;

/**
 * Global Master Employee QR Identity Card component (single source of truth).
 * Preserves the exact QR Management card design:
 * - FACTORY IDENTITY CARD + Narid ATDC Tracker header
 * - Large, clear, unobstructed scannable QR code
 * - Employee ID, Employee Name, Designation
 * - Line, Section, Department footer grid
 * Gracefully falls back to "—" when optional employee details are missing.
 */
export const EmployeeQrCard: React.FC<EmployeeQrCardProps> = ({
  employee,
  qrUrl,
}) => (
  <div className="qr-identity-print-card border border-slate-300 rounded-lg overflow-hidden flex flex-col items-center text-center bg-white shadow-2xs">
    {/* Top Corporate Bar */}
    <div className="w-full h-1.5 bg-blue-900" />

    {/* HEADER */}
    <div className="w-full bg-slate-50 border-b border-slate-200 px-3 py-2 text-center">
      <div className="text-[9px] font-bold tracking-[0.14em] text-blue-900 uppercase">
        {IDENTITY_CARD_HEADER_TEXT.title}
      </div>
      <div className="text-xs font-extrabold text-slate-900 leading-tight mt-0.5">
        {IDENTITY_CARD_HEADER_TEXT.brand}
      </div>
    </div>

    {/* CENTER: Pure Unobstructed QR Code */}
    <div className="px-4 pt-3 pb-2 flex items-center justify-center">
      <div className="w-32 h-32 bg-white border border-slate-300 p-1.5 rounded flex items-center justify-center">
        {qrUrl ? (
          <img
            src={qrUrl}
            alt={employee.employeeId || 'Employee QR'}
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="w-full h-full bg-slate-100 rounded" />
        )}
      </div>
    </div>

    {/* EMPLOYEE DETAILS BELOW QR */}
    <div className="px-3 pb-2.5 w-full space-y-1">
      <div>
        <div className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Employee ID
        </div>
        <div className="font-mono text-sm font-extrabold text-slate-900 leading-tight">
          {employee.employeeId || '—'}
        </div>
      </div>
      <div>
        <div className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Employee Name
        </div>
        <div className="text-xs font-bold text-slate-900 leading-snug break-words">
          {employee.employeeName || '—'}
        </div>
      </div>
      <div>
        <div className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Designation
        </div>
        <div className="text-[11px] font-bold text-blue-700 leading-tight break-words">
          {employee.designation || '—'}
        </div>
      </div>
    </div>

    {/* BOTTOM DETAILS */}
    <div className="w-full mt-auto bg-slate-50 border-t border-slate-200 grid grid-cols-3 divide-x divide-slate-200 text-center">
      <div className="px-1.5 py-2">
        <span className="block text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Line
        </span>
        <span className="block text-[10px] font-bold text-slate-900 leading-tight mt-0.5 break-words">
          {employee.floor || '—'}
        </span>
      </div>
      <div className="px-1.5 py-2">
        <span className="block text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Section
        </span>
        <span className="block text-[10px] font-bold text-slate-900 leading-tight mt-0.5 break-words">
          {employee.section || '—'}
        </span>
      </div>
      <div className="px-1.5 py-2">
        <span className="block text-[8px] font-bold uppercase tracking-wider text-slate-500">
          Department
        </span>
        <span className="block text-[10px] font-bold text-slate-900 leading-tight mt-0.5 break-words">
          {employee.department || '—'}
        </span>
      </div>
    </div>
  </div>
);

export const EmployeeIdentityPrintCard = EmployeeQrCard;
