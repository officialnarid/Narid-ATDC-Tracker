import React, { useState, useEffect } from 'react';

interface SplashScreenProps {
  onFinish: () => void;
  durationMs?: number; // 5000ms (5 seconds)
  fadeOutMs?: number;  // 800ms
}

export const SplashScreen: React.FC<SplashScreenProps> = ({
  onFinish,
  durationMs = 5000,
  fadeOutMs = 800,
}) => {
  const [mounted, setMounted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isFadingOut, setIsFadingOut] = useState(false);

  useEffect(() => {
    // 1. Subtle smooth entrance
    const raf = requestAnimationFrame(() => {
      setMounted(true);
    });

    // 2. Animate progress bar across 5 seconds
    const progressTimer = setTimeout(() => {
      setProgress(100);
    }, 50);

    // 3. Trigger cinematic fade-out at exactly 5000ms
    const displayTimer = setTimeout(() => {
      setIsFadingOut(true);
    }, durationMs);

    // 4. After smooth fade-out completes, reveal the dashboard
    const exitTimer = setTimeout(() => {
      onFinish();
    }, durationMs + fadeOutMs);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(progressTimer);
      clearTimeout(displayTimer);
      clearTimeout(exitTimer);
    };
  }, [durationMs, fadeOutMs, onFinish]);

  return (
    <div
      role="banner"
      aria-label="NARID Splash Screen"
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center select-none overflow-hidden transition-all ease-in-out ${
        isFadingOut 
          ? 'opacity-0 pointer-events-none' 
          : mounted 
            ? 'opacity-100 pointer-events-auto' 
            : 'opacity-0 pointer-events-auto'
      }`}
      style={{
        background: 'radial-gradient(circle at 50% 48%, #282a2e 0%, #1d1e21 55%, #131416 100%)',
        transitionDuration: isFadingOut ? `${fadeOutMs}ms` : '600ms',
      }}
    >
      {/* Premium Ambient Backlight / Aura */}
      <div 
        className="absolute w-[500px] h-[500px] rounded-full pointer-events-none blur-3xl filter animate-splash-aura"
        style={{
          background: 'radial-gradient(circle, rgba(59, 130, 246, 0.16) 0%, rgba(14, 165, 233, 0.08) 50%, transparent 75%)',
        }}
      />

      {/* Main Logo Container with Smooth Scale Animation */}
      <div 
        className={`relative w-full max-w-3xl px-8 sm:px-12 flex flex-col items-center justify-center transition-all ease-out duration-1000 ${
          isFadingOut 
            ? 'scale-[1.04] blur-xs' 
            : mounted 
              ? 'scale-100' 
              : 'scale-95'
        }`}
      >
        {/* Logo Wrapper with Shimmer Glass Effect */}
        <div className="relative w-full flex items-center justify-center overflow-hidden rounded-xl">
          <img
            src="/assets/narid-logo.png"
            alt="NARID - Built For A Brighter Tomorrow"
            className="w-full max-h-[62vh] object-contain drop-shadow-[0_20px_50px_rgba(0,0,0,0.8)]"
            draggable={false}
          />

          {/* Luxury Metallic Light Sheen Sweep */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div 
              className="w-1/2 h-full bg-gradient-to-r from-transparent via-white/12 to-transparent animate-splash-shimmer pointer-events-none" 
            />
          </div>
        </div>

        {/* Minimalist Industrial Loading Indicator & Status */}
        <div 
          className={`mt-8 flex flex-col items-center gap-3 transition-opacity duration-700 delay-300 ${
            mounted && !isFadingOut ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {/* 2px Precision Progress Line */}
          <div className="w-56 sm:w-64 h-[2.5px] bg-white/10 rounded-full overflow-hidden backdrop-blur-xs">
            <div 
              className="h-full bg-gradient-to-r from-blue-500 via-cyan-400 to-blue-400 rounded-full shadow-[0_0_12px_rgba(56,189,248,0.7)]"
              style={{
                width: `${progress}%`,
                transition: `width ${durationMs}ms cubic-bezier(0.2, 0.8, 0.25, 1)`,
              }}
            />
          </div>

          {/* Subtitle / System Initializer */}
          <div className="flex items-center gap-2 text-[10px] sm:text-[11px] font-mono tracking-widest uppercase text-slate-400">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(34,211,238,0.9)]" />
            <span className="text-slate-300 font-semibold tracking-wider">NARID ATDC TRACKER</span>
            <span className="text-slate-600">•</span>
            <span className="text-slate-400">INITIALIZING SYSTEM</span>
          </div>
        </div>
      </div>
    </div>
  );
};
