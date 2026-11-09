import React, { useState } from 'react';
import { 
  User, 
  Lock, 
  Eye, 
  EyeOff, 
  LogIn, 
  ShieldCheck, 
  AlertCircle, 
  Calendar,
  QrCode,
  Users,
  BarChart3
} from 'lucide-react';
import { loginWithLoginIdAndPassword } from '../services/authService';
import { UserRoleRecord } from '../types';

interface LoginProps {
  onLoginSuccess: (profile: UserRoleRecord) => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Handle Sign In submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!loginId.trim()) {
      setErrorMessage('Please enter your Login ID or registered Email.');
      return;
    }
    if (!password) {
      setErrorMessage('Please enter your password.');
      return;
    }

    setIsLoading(true);
    try {
      const { profile } = await loginWithLoginIdAndPassword(loginId, password, true);
      onLoginSuccess(profile);
    } catch (err: any) {
      console.warn('Authentication failed:', err?.message || err);
      const rawMsg = err?.message || '';
      if (
        rawMsg.includes('Invalid password') || 
        rawMsg.includes('password') || 
        rawMsg.includes('credentials') ||
        rawMsg.includes('user-not-found') ||
        rawMsg.includes('wrong-password')
      ) {
        setErrorMessage('Invalid password, check again');
      } else {
        setErrorMessage(rawMsg || 'Invalid password, check again');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-screen flex flex-col lg:flex-row bg-[#edf2f7] text-slate-800 font-sans overflow-x-hidden select-none">
      
      {/* ================= LEFT SECTION (60% Width on Desktop): Industrial Hero Design ================= */}
      <div className="lg:w-[60%] relative bg-[#001438] flex flex-col justify-between overflow-hidden p-6 sm:p-8 lg:p-10 text-white z-10 shadow-2xl">
        
        {/* Background Multi-Layer Deep Industrial Blue Gradients & Waves */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#000e29] via-[#001740] to-[#00245e] pointer-events-none" />
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-blue-500/15 blur-3xl pointer-events-none" />
        <div className="absolute top-1/3 -right-20 w-80 h-80 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />

        {/* Top Branding Section */}
        <div className="relative z-10 flex flex-col items-start">
          <div className="flex items-center gap-3.5">
            {/* Original Uploaded ENR Logo */}
            <div className="p-1 rounded-lg bg-black/60 border border-white/20 shadow-md">
              <img 
                src="/assets/aistudio/image_f76489f6.png" 
                alt="NARID ENR" 
                className="h-10 sm:h-12 w-auto object-contain"
              />
            </div>
            
            {/* Vertical Divider & Corporate Subtext */}
            <div className="border-l border-white/30 pl-3.5">
              <span className="text-[10px] sm:text-[11px] tracking-widest uppercase text-slate-200 font-semibold block leading-tight">
                BUILT FOR A BRIGHTER TOMORROW
              </span>
              <span className="text-xs sm:text-sm text-white font-bold tracking-wider block mt-0.5">
                PRECISION INDUSTRIAL CORP
              </span>
            </div>
          </div>

          {/* Main Heading */}
          <h1 className="text-3xl sm:text-4xl lg:text-[40px] font-black text-white tracking-wide mt-4 drop-shadow-md">
            NARID ATDC TRACKER
          </h1>

          {/* Industrial Attendance System Badge / Subtitle */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 mt-2 rounded-full bg-blue-600/30 border border-blue-400/40 text-blue-200 text-xs sm:text-sm font-bold tracking-wider uppercase backdrop-blur-xs">
            <span className="text-cyan-400">///</span>
            <span>INDUSTRIAL ATTENDANCE SYSTEM</span>
            <span className="text-cyan-400">///</span>
          </div>
        </div>

        {/* Main Industrial Image Container (Separate Container, object-cover, No Text Overlap) */}
        <div className="relative z-10 my-6 flex-1 flex items-center justify-center min-h-[300px] lg:min-h-[380px]">
          <div className="relative w-full h-full max-h-[50vh] rounded-2xl overflow-hidden shadow-[0_20px_50px_rgba(0,0,0,0.7)] border border-blue-400/25 bg-slate-950 group">
            <img
              src="/assets/factory-scanner-hero.png"
              alt="Industrial Factory Attendance Terminal with QR Scanner and Safety Employee"
              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.02]"
              draggable={false}
            />
            {/* Subtle Vignette to integrate seamlessly into dark navy card */}
            <div className="absolute inset-0 bg-gradient-to-t from-[#001438]/50 via-transparent to-black/20 pointer-events-none" />
            <div className="absolute inset-0 border border-white/10 rounded-2xl pointer-events-none" />
          </div>
        </div>

        {/* Bottom Feature Highlights Bar (4 Distinct Blocks with subtle dividers) */}
        <div className="relative z-10 grid grid-cols-2 sm:grid-cols-4 gap-2 pt-4 border-t border-blue-400/20 bg-[#001233]/40 rounded-xl px-2 py-3 backdrop-blur-xs">
          
          {/* Feature 1: Attendance Tracking */}
          <div className="flex flex-col items-center text-center p-2 sm:border-r sm:border-blue-400/20">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-400/20 flex items-center justify-center mb-1.5">
              <Calendar className="w-5 h-5 text-cyan-400" />
            </div>
            <span className="text-xs font-bold text-slate-100 leading-tight">
              Attendance
            </span>
            <span className="text-[11px] font-medium text-slate-300">
              Tracking
            </span>
          </div>

          {/* Feature 2: QR Based Punch In/Out */}
          <div className="flex flex-col items-center text-center p-2 sm:border-r sm:border-blue-400/20">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-400/20 flex items-center justify-center mb-1.5">
              <QrCode className="w-5 h-5 text-emerald-400" />
            </div>
            <span className="text-xs font-bold text-slate-100 leading-tight">
              QR Based
            </span>
            <span className="text-[11px] font-medium text-slate-300">
              Punch In/Out
            </span>
          </div>

          {/* Feature 3: Manpower Monitoring */}
          <div className="flex flex-col items-center text-center p-2 sm:border-r sm:border-blue-400/20">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-400/20 flex items-center justify-center mb-1.5">
              <Users className="w-5 h-5 text-sky-400" />
            </div>
            <span className="text-xs font-bold text-slate-100 leading-tight">
              Manpower
            </span>
            <span className="text-[11px] font-medium text-slate-300">
              Monitoring
            </span>
          </div>

          {/* Feature 4: Reports & Analytics */}
          <div className="flex flex-col items-center text-center p-2">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-400/20 flex items-center justify-center mb-1.5">
              <BarChart3 className="w-5 h-5 text-amber-400" />
            </div>
            <span className="text-xs font-bold text-slate-100 leading-tight">
              Reports &
            </span>
            <span className="text-[11px] font-medium text-slate-300">
              Analytics
            </span>
          </div>
        </div>

        {/* Dynamic Curved Wave Graphic Divider on Desktop (Swooping gracefully toward right section) */}
        <div className="hidden lg:block absolute -right-1 top-0 bottom-0 w-16 pointer-events-none z-20 overflow-hidden">
          <svg 
            className="h-full w-full fill-[#edf2f7]" 
            viewBox="0 0 100 1000" 
            preserveAspectRatio="none"
          >
            <path d="M100,0 C60,250 85,500 20,750 C-10,870 5,950 100,1000 L100,0 Z" />
          </svg>
        </div>
        
        {/* Layered Blue Wave Accent across bottom curve */}
        <div className="absolute -bottom-8 -right-8 w-80 h-32 bg-gradient-to-r from-blue-600/40 via-cyan-500/30 to-transparent rounded-full blur-2xl pointer-events-none" />
      </div>

      {/* ================= RIGHT SECTION (40% Width on Desktop): Login Form Card ================= */}
      <div className="lg:w-[40%] flex items-center justify-center p-6 sm:p-10 lg:p-12 bg-gradient-to-br from-[#edf2f7] via-[#f1f5f9] to-[#e2e8f0] relative">
        
        {/* Centered Floating White Login Card */}
        <div className="w-full max-w-md bg-white rounded-3xl shadow-[0_20px_60px_-15px_rgba(0,20,56,0.18)] border border-slate-200/90 p-8 sm:p-10 flex flex-col justify-between relative z-10 transition-all">
          
          {/* Card Header */}
          <div className="text-center mb-8">
            <h2 className="text-3xl sm:text-[32px] font-black text-[#0a192f] tracking-tight">
              Welcome Back
            </h2>
            <p className="text-sm text-slate-500 mt-1.5 font-medium">
              Sign in to your account
            </p>
            {/* Modern Blue Accent Line */}
            <div className="w-16 h-1.5 bg-gradient-to-r from-blue-600 via-sky-500 to-cyan-400 rounded-full mx-auto mt-3.5 shadow-sm" />
          </div>

          {/* Clean Error Message Box (If Invalid Password) */}
          {errorMessage && (
            <div className="mb-6 p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs sm:text-sm flex items-start gap-2.5 animate-shake shadow-xs">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <div className="leading-relaxed font-semibold">{errorMessage}</div>
            </div>
          )}

          {/* Sign In Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            
            {/* Login ID Input */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-2 uppercase tracking-wider">
                LOGIN ID / USERNAME
              </label>
              <div className="relative flex items-center rounded-2xl border border-slate-200 bg-slate-50/80 hover:bg-white focus-within:bg-white focus-within:border-blue-600 focus-within:ring-3 focus-within:ring-blue-100 transition-all">
                <div className="pl-4 pr-2 text-slate-400">
                  <User className="w-5 h-5" />
                </div>
                <input
                  type="text"
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  placeholder="Enter your Login ID"
                  autoComplete="username"
                  required
                  className="w-full py-3.5 pr-4 text-sm text-slate-900 bg-transparent border-none focus:outline-hidden font-medium placeholder:text-slate-400"
                />
              </div>
            </div>

            {/* Password Input with Show/Hide Toggle */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-2 uppercase tracking-wider">
                PASSWORD
              </label>
              <div className="relative flex items-center rounded-2xl border border-slate-200 bg-slate-50/80 hover:bg-white focus-within:bg-white focus-within:border-blue-600 focus-within:ring-3 focus-within:ring-blue-100 transition-all">
                <div className="pl-4 pr-2 text-slate-400">
                  <Lock className="w-5 h-5" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                  className="w-full py-3.5 pr-11 text-sm text-slate-900 bg-transparent border-none focus:outline-hidden font-medium placeholder:text-slate-400"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 p-1 text-slate-400 hover:text-slate-700 focus:outline-hidden cursor-pointer transition-colors"
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Modern Blue Gradient SIGN IN Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full mt-3 bg-gradient-to-r from-blue-600 via-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 active:scale-[0.99] text-white font-bold py-3.5 px-6 rounded-2xl shadow-lg shadow-blue-600/30 flex items-center justify-center gap-2.5 transition-all disabled:opacity-70 disabled:cursor-not-allowed text-sm uppercase tracking-wider cursor-pointer"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Verifying Account...</span>
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  <span>SIGN IN</span>
                </>
              )}
            </button>
          </form>

          {/* Footer Security Badge: Authorized Personnel Only */}
          <div className="mt-8 pt-6 border-t border-slate-100 flex items-center justify-center gap-2 text-slate-600 text-xs sm:text-sm font-semibold">
            <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0" />
            <span>Authorized Personnel Only</span>
          </div>

        </div>
      </div>

    </div>
  );
};
