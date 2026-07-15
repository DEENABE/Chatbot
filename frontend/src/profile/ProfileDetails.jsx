import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, User, Folder, FileText, Brain, ShieldAlert, Award, KeyRound, Lock, Check, ChevronDown } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { presets } from '../animations/presets.js';

export default function ProfileDetails({ onClose }) {
  const user = useAppStore((state) => state.user);
  const conversations = useAppStore((state) => state.conversations);
  const folders = useAppStore((state) => state.folders);
  const documents = useAppStore((state) => state.documents);
  const memories = useAppStore((state) => state.memories);
  const settings = useAppStore((state) => state.settings);
  const changePassword = useAppStore((state) => state.changePassword);

  const accent = settings.accentColor || '#3b82f6';

  const [showPwForm, setShowPwForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwError('');
    setPwSuccess(false);
    if (newPassword.length < 4) {
      setPwError('New password must be at least 4 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError('New passwords do not match.');
      return;
    }
    setPwLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      setPwSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => { setShowPwForm(false); setPwSuccess(false); }, 1500);
    } catch (err) {
      setPwError(err.response?.data?.error || err.message || 'Could not change password.');
    } finally {
      setPwLoading(false);
    }
  };

  const pwInputStyle = 'w-full rounded-lg border border-white/[0.06] bg-[#09090a]/70 py-2 pl-8 pr-3 text-[11px] text-stone-200 placeholder-stone-600 outline-none transition-all focus:border-white/20';

  return createPortal(
    <div 
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm select-none"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div 
        initial={{ scale: 0.96, opacity: 0 }} 
        animate={{ scale: 1, opacity: 1 }} 
        exit={{ scale: 0.96, opacity: 0 }}
        className="w-full max-w-xs rounded-2xl border border-white/[0.06] bg-[#121214] shadow-2xl backdrop-blur-xl overflow-hidden"
        transition={presets.appleBounce}
      >
        {/* Header */}
        <div className="flex justify-between items-center px-5 pt-4 pb-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <User size={14} style={{ color: accent }} />
            <h3 className="text-[11px] font-bold text-stone-300 uppercase tracking-widest">Profile</h3>
          </div>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-300 transition-colors cursor-pointer p-1 -mr-1 rounded-lg hover:bg-white/5">
            <X size={14} />
          </button>
        </div>

        {/* User Card */}
        <div className="px-5 py-4">
          <div className="flex items-center gap-3 mb-4">
            <div 
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-base font-extrabold text-black shadow-lg"
              style={{ background: accent, boxShadow: `0 4px 14px ${accent}40` }}
            >
              {(user?.displayName || user?.username || 'A').charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-bold text-white truncate leading-tight">
                {user?.displayName || user?.username}
              </h4>
              <p className="text-[10px] text-stone-500 font-mono truncate">@{user?.username || 'admin'}</p>
            </div>
            <div className="flex items-center gap-1 text-[7px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
              <Award size={8} />
              Admin
            </div>
          </div>

          {/* Role & Department */}
          <div className="flex gap-2 mb-4">
            <div className="flex-1 rounded-lg bg-white/[0.02] border border-white/[0.04] px-3 py-2">
              <div className="text-[8px] uppercase tracking-wider text-stone-600 font-bold mb-0.5">Role</div>
              <div className="text-[11px] text-stone-300 font-medium truncate">{user?.role || 'Employee'}</div>
            </div>
            <div className="flex-1 rounded-lg bg-white/[0.02] border border-white/[0.04] px-3 py-2">
              <div className="text-[8px] uppercase tracking-wider text-stone-600 font-bold mb-0.5">Dept</div>
              <div className="text-[11px] text-stone-300 font-medium truncate">{user?.department || 'Chanakya AI Core'}</div>
            </div>
          </div>
        </div>

        {/* Workspace Stats */}
        <div className="px-5 pb-4">
          <span className="text-[8px] uppercase font-bold text-stone-600 tracking-widest block mb-2">Workspace Stats</span>
          
          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            <div className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
              <div className="flex items-center gap-1.5 text-stone-400">
                <Folder size={11} />
                <span>Chats</span>
              </div>
              <span className="font-bold text-white font-mono text-[10px]">{conversations.length}</span>
            </div>

            <div className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
              <div className="flex items-center gap-1.5 text-stone-400">
                <Folder size={11} style={{ color: accent }} />
                <span>Folders</span>
              </div>
              <span className="font-bold text-white font-mono text-[10px]">{folders.length}</span>
            </div>

            <div className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
              <div className="flex items-center gap-1.5 text-stone-400">
                <FileText size={11} />
                <span>Docs</span>
              </div>
              <span className="font-bold text-white font-mono text-[10px]">{documents.length}</span>
            </div>

            <div className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
              <div className="flex items-center gap-1.5 text-stone-400">
                <Brain size={11} />
                <span>Facts</span>
              </div>
              <span className="font-bold text-white font-mono text-[10px]">{memories.length}</span>
            </div>
          </div>

          {/* Security / Change Password */}
          <div className="mt-3">
            <button
              onClick={() => { setShowPwForm((v) => !v); setPwError(''); setPwSuccess(false); }}
              className="flex w-full items-center justify-between rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2 text-[11px] font-medium text-stone-300 hover:bg-white/[0.04] transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                <KeyRound size={12} style={{ color: accent }} />
                Change Password
              </span>
              <ChevronDown size={13} className={`text-stone-500 transition-transform ${showPwForm ? 'rotate-180' : ''}`} />
            </button>

            <AnimatePresence initial={false}>
              {showPwForm && (
                <motion.form
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  onSubmit={handleChangePassword}
                  className="overflow-hidden"
                >
                  <div className="space-y-2 pt-2.5">
                    <div className="relative">
                      <Lock className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-stone-600" />
                      <input
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder="Current password"
                        required
                        className={pwInputStyle}
                      />
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-stone-600" />
                      <input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="New password"
                        required
                        className={pwInputStyle}
                      />
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-stone-600" />
                      <input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Confirm new password"
                        required
                        className={pwInputStyle}
                      />
                    </div>

                    {pwError && (
                      <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-[10px] text-red-400">
                        {pwError}
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={pwLoading}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-[11px] font-semibold text-black transition-all disabled:opacity-50 cursor-pointer"
                      style={{ background: pwSuccess ? '#10b981' : accent }}
                    >
                      {pwLoading ? (
                        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-black/30 border-t-black" />
                      ) : pwSuccess ? (
                        <><Check size={13} /> Updated</>
                      ) : (
                        'Update Password'
                      )}
                    </button>
                  </div>
                </motion.form>
              )}
            </AnimatePresence>
          </div>

          {/* Privacy Seal */}
          <div className="flex gap-2 rounded-lg border border-white/[0.04] bg-[#09090a]/40 p-2.5 text-[8px] text-stone-500 leading-[1.4] mt-3">
            <ShieldAlert size={12} style={{ color: accent }} className="shrink-0 mt-0.5" />
            <span>All data is stored locally on this device. No external telemetry or cloud sync.</span>
          </div>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
