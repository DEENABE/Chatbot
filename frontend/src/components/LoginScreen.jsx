import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { User as UserIcon, Lock, ArrowRight, UserPlus, LogIn, Sparkles, Shield, Eye, EyeOff } from "lucide-react";
import { useAppStore } from "../stores/useAppStore.js";
import { presets } from "../animations/presets.js";
import ChanakyaAvatar from "./ChanakyaAvatar.jsx";

export default function LoginScreen() {
  const [isRegister, setIsRegister] = useState(false);
  const [isReset, setIsReset] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);
  const [focusedField, setFocusedField] = useState(null);

  const login = useAppStore((state) => state.login);
  const register = useAppStore((state) => state.register);
  const resetPassword = useAppStore((state) => state.resetPassword);
  const settings = useAppStore((state) => state.settings);

  const switchMode = (register) => {
    setIsRegister(register);
    setIsReset(false);
    setError("");
    setInfo("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setLoading(true);

    try {
      if (isReset) {
        if (password !== confirmPassword) {
          throw new Error("New passwords do not match.");
        }
        await resetPassword(username, password);
        setInfo("Password updated. Sign in with your new password.");
        setIsReset(false);
        setPassword("");
        setConfirmPassword("");
      } else if (isRegister) {
        await register(username, displayName, password);
        // Login/register succeeded — `user` is now set, so this same
        // (already-expanded) window naturally re-renders into the chat
        // workspace instead of the login form. Collapsing to the bubble here
        // (the previous behavior) made a successful login look like it had
        // failed: the window would immediately shrink away right after
        // signing in, instead of showing the workspace the user just logged
        // into.
      } else {
        await login(username, password);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const accent = settings.accentColor || '#3b82f6';

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-transparent rounded-2xl select-none">
      {/* Animated background orbs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div
          animate={{ x: [0, 40, -20, 0], y: [0, -30, 40, 0], scale: [1, 1.15, 0.95, 1] }}
          transition={{ duration: 15, repeat: Infinity, ease: "easeInOut" }}
          className="absolute -left-20 -top-20 h-[350px] w-[350px] rounded-full blur-3xl"
          style={{ background: `radial-gradient(circle, ${accent}15 0%, transparent 70%)` }}
        />
        <motion.div
          animate={{ x: [0, -30, 20, 0], y: [0, 40, -20, 0], scale: [1, 0.9, 1.1, 1] }}
          transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
          className="absolute -bottom-20 -right-20 h-[400px] w-[400px] rounded-full blur-3xl"
          style={{ background: `radial-gradient(circle, ${accent}10 0%, transparent 70%)` }}
        />
      </div>

      <div className="noise pointer-events-none absolute inset-0" />

      {/* Login Card */}
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 w-full max-w-sm px-6"
      >
        {/* Top branding */}
        <div className="mb-6 text-center">
          <ChanakyaAvatar accentColor={accent} />
          
          <h1 className="text-xl font-bold tracking-tight text-white uppercase tracking-wider">
            <span>Chanakya AI</span>
          </h1>
          <p className="mt-1 text-[10px] text-stone-500">Your secure offline AI assistant</p>
        </div>

        {/* Card body */}
        <div className="glass-card panel rounded-2xl p-6 shadow-2xl">
          {/* Tab switcher */}
          <div className="mb-5 flex rounded-xl border border-white/[0.04] bg-[#09090a]/60 p-1">
            <button
              onClick={() => switchMode(false)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-all duration-300 cursor-pointer"
              style={{
                background: !isRegister ? `linear-gradient(135deg, ${accent}30, ${accent}15)` : 'transparent',
                color: !isRegister ? '#fff' : '#78716c',
                boxShadow: !isRegister ? `0 4px 10px ${accent}15` : 'none'
              }}
            >
              <LogIn size={13} />
              {isReset ? 'Reset' : 'Sign In'}
            </button>
            <button
              onClick={() => switchMode(true)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-all duration-300 cursor-pointer"
              style={{
                background: isRegister ? `linear-gradient(135deg, ${accent}30, ${accent}15)` : 'transparent',
                color: isRegister ? '#fff' : '#78716c',
                boxShadow: isRegister ? `0 4px 10px ${accent}15` : 'none'
              }}
            >
              <UserPlus size={13} />
              Register
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-3.5">
            {/* Username */}
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                Username
              </label>
              <div className="relative">
                <UserIcon className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-600" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onFocus={() => setFocusedField('username')}
                  onBlur={() => setFocusedField(null)}
                  placeholder="Username"
                  required
                  autoFocus
                  className="w-full rounded-xl border bg-[#09090a]/70 py-2 pl-9 pr-3 text-xs text-stone-200 placeholder-stone-600 outline-none transition-all focus:ring-1 focus:ring-opacity-20"
                  style={{ 
                    borderColor: focusedField === 'username' ? accent : 'rgba(255, 255, 255, 0.08)',
                    boxShadow: focusedField === 'username' ? `0 0 8px ${accent}30` : 'none'
                  }}
                />
              </div>
            </div>

            {/* Display Name (register only) */}
            <AnimatePresence initial={false}>
              {isRegister && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                    Display Name
                  </label>
                  <div className="relative">
                    <UserIcon className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-600" />
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      onFocus={() => setFocusedField('display')}
                      onBlur={() => setFocusedField(null)}
                      placeholder="Display Name"
                      className="w-full rounded-xl border bg-[#09090a]/70 py-2 pl-9 pr-3 text-xs text-stone-200 placeholder-stone-600 outline-none transition-all focus:ring-1 focus:ring-opacity-20"
                      style={{ 
                        borderColor: focusedField === 'display' ? accent : 'rgba(255, 255, 255, 0.08)',
                        boxShadow: focusedField === 'display' ? `0 0 8px ${accent}30` : 'none'
                      }}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Password */}
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                {isReset ? 'New Password' : 'Password'}
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-600" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={() => setFocusedField('password')}
                  onBlur={() => setFocusedField(null)}
                  placeholder={isReset ? 'New Password' : 'Password'}
                  required
                  className="w-full rounded-xl border bg-[#09090a]/70 py-2 pl-9 pr-9 text-xs text-stone-200 placeholder-stone-600 outline-none transition-all focus:ring-1 focus:ring-opacity-20"
                  style={{ 
                    borderColor: focusedField === 'password' ? accent : 'rgba(255, 255, 255, 0.08)',
                    boxShadow: focusedField === 'password' ? `0 0 8px ${accent}30` : 'none'
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-600 hover:text-stone-400 transition-colors cursor-pointer"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {/* Confirm New Password (reset only) */}
            <AnimatePresence initial={false}>
              {isReset && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                    Confirm New Password
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-600" />
                    <input
                      type={showPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Confirm New Password"
                      required
                      className="w-full rounded-xl border bg-[#09090a]/70 py-2 pl-9 pr-3 text-xs text-stone-200 placeholder-stone-600 outline-none transition-all focus:ring-1"
                      style={{ borderColor: 'rgba(255, 255, 255, 0.08)' }}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Forgot password link (sign-in only) */}
            {!isRegister && !isReset && (
              <div className="flex justify-end -mt-1.5">
                <button
                  type="button"
                  onClick={() => { setIsReset(true); setError(''); setInfo(''); }}
                  className="text-[10px] text-stone-500 hover:text-stone-300 transition-colors cursor-pointer"
                >
                  Forgot password?
                </button>
              </div>
            )}

            {/* Error / Info */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[10px] text-red-400"
                >
                  {error}
                </motion.div>
              )}
              {info && !error && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[10px] text-emerald-400"
                >
                  {info}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Submit Button */}
            <motion.button
              type="submit"
              disabled={loading}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.98 }}
              className="group flex w-full items-center justify-center gap-1.5 rounded-xl py-3 text-xs font-semibold text-black transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              style={{
                background: `linear-gradient(135deg, ${accent}, ${accent}dd)`,
                boxShadow: `0 4px 12px ${accent}25`
              }}
            >
              {loading ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />
              ) : (
                <>
                  {isReset ? "Reset Password" : isRegister ? "Create Account" : "Sign In"}
                  <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                </>
              )}
            </motion.button>

            {/* Back to Sign In (reset only) */}
            {isReset && (
              <button
                type="button"
                onClick={() => switchMode(false)}
                className="w-full text-center text-[10px] text-stone-500 hover:text-stone-300 transition-colors cursor-pointer"
              >
                ← Back to Sign In
              </button>
            )}
          </form>
        </div>

        {/* Bottom Security Badge */}
        <div className="mt-4 flex items-center justify-center gap-1.5 text-[9px] text-stone-600 font-mono">
          <Shield size={11} className="text-emerald-500/50" />
          Offline security — data remains localized
        </div>
      </motion.div>
    </div>
  );
}
