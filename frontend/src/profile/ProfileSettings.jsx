import React, { useState } from 'react';
import { useAppStore } from '../stores/useAppStore.js';
import ProfileDetails from './ProfileDetails.jsx';

export default function ProfileSettings() {
  const user = useAppStore((state) => state.user);
  const updateProfile = useAppStore((state) => state.updateProfile);
  const accent = useAppStore((state) => state.settings.accentColor) || '#3b82f6';
  const [form, setForm] = useState({
    displayName: user?.displayName || '',
    email: user?.email || '',
    department: user?.department || '',
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [showSecurity, setShowSecurity] = useState(false);
  const save = async (event) => {
    event.preventDefault();
    setNotice('');
    setError('');
    if (!form.displayName.trim() || form.displayName.trim().length > 100) {
      setError('Display name must contain 1 to 100 characters.');
      return;
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      setError('Enter a valid email address or leave it blank.');
      return;
    }
    setBusy(true);
    try {
      await updateProfile({
        ...form,
        displayName: form.displayName.trim(),
        email: form.email.trim(),
        department: form.department.trim(),
      });
      setNotice('Profile saved on this device.');
    } catch (failure) {
      setError(failure.response?.data?.error || 'Profile could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 text-sm text-stone-300">
      <div className="flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-lg font-semibold text-black"
          style={{ background: accent }}
          aria-hidden="true"
        >
          {(user?.displayName || user?.username || '?').charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-white">
            {user?.displayName || user?.username}
          </h3>
          <p className="mt-0.5 truncate text-xs text-stone-500">
            @{user?.username} · {user?.role || 'User'}
            {user?.department ? ` · ${user.department}` : ''}
          </p>
        </div>
      </div>
      <form onSubmit={save} className="space-y-3">
        {[
          { key: 'displayName', label: 'Display name', max: 100 },
          { key: 'email', label: 'Email (optional)', max: 254, type: 'email' },
          { key: 'department', label: 'Department (optional)', max: 100 },
        ].map((field) => (
          <label key={field.key} className="block text-xs text-stone-400">
            {field.label}
            <input
              type={field.type || 'text'}
              value={form[field.key]}
              maxLength={field.max}
              required={field.key === 'displayName'}
              onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-blue-400"
            />
          </label>
        ))}
        {error && (
          <p role="alert" className="text-xs text-red-300">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-xs text-emerald-300">
            {notice}
          </p>
        )}
        <button
          disabled={busy}
          className="rounded-lg bg-blue-500 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </form>
      <div className="border-t border-white/10 pt-3">
        <button
          type="button"
          onClick={() => setShowSecurity(true)}
          className="text-xs text-stone-300 underline"
        >
          Password and account controls
        </button>
      </div>
      {showSecurity && <ProfileDetails onClose={() => setShowSecurity(false)} />}
    </div>
  );
}
