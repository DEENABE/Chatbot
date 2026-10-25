import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import {
  Activity,
  Brain,
  ChevronRight,
  Clock,
  Code2,
  FileText,
  Folder,
  FolderOpen,
  Languages,
  Library,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { useNavStore } from '../stores/useNavStore.js';
import * as apiService from '../services/api.js';
import { formatBytes } from '../utils/attachments.js';
import { presets } from '../animations/presets.js';

// The four top-level sections. `title` is the tooltip / test hook, `label` is
// what is shown and announced.
const NAV_ITEMS = [
  { id: 'chat', label: 'Chat', title: 'Chat', icon: MessageSquare },
  { id: 'coding', label: 'Code', title: 'Code', icon: Code2 },
  { id: 'workspace', label: 'Workspace', title: 'Workspace files', icon: FolderOpen },
  { id: 'history', label: 'History', title: 'History', icon: Clock },
  { id: 'settings', label: 'Settings', title: 'Settings', icon: Settings },
];

// Hovering "Workspace" opens a flyout with these shortcuts. The ids match the
// sections of the Workspace page (stores/useNavStore.js WORKSPACE_TABS).
const WORKSPACE_LINKS = [
  { id: 'files', label: 'Files', hint: 'Folders indexed for chat', icon: FolderOpen },
  { id: 'coding', label: 'Coding', hint: 'Local coding tasks and project changes', icon: Code2 },
  { id: 'knowledge', label: 'Knowledge', hint: 'Documents every chat can use', icon: Library },
  { id: 'memories', label: 'Memories', hint: 'What Chanakya remembers', icon: Brain },
  { id: 'translator', label: 'Translator', hint: 'Offline translation', icon: Languages },
  { id: 'apps', label: 'Apps', hint: 'App permissions', icon: ShieldCheck },
  { id: 'diagnostics', label: 'Diagnostics', hint: 'System health and logs', icon: Activity },
];

const RECENT_LIMIT = 4;
const FLYOUT_FILES = 5;
const FLYOUT_WIDTH = 288;
const FLYOUT_HEIGHT = 440; // approximate full height, used to keep it on-screen
const FLYOUT_CACHE_MS = 30_000;

/**
 * "Workspace" entry of the sidebar. Click opens the Workspace page; hovering
 * (or keyboard focus) shows a flyout with the active workspace's files and
 * one-click shortcuts to every Workspace section.
 */
function WorkspaceNavItem({ item, open, active, accent, onOpen }) {
  const openWorkspace = useNavStore((state) => state.openWorkspace);
  const documents = useAppStore((state) => state.documents);
  const [position, setPosition] = useState(null); // null = closed
  const [snapshot, setSnapshot] = useState({ state: 'idle' });
  const buttonRef = useRef(null);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const suppressed = useRef(false); // set by a click, cleared when the pointer leaves
  const loadedAt = useRef(0);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    [],
  );

  const load = async () => {
    if (Date.now() - loadedAt.current < FLYOUT_CACHE_MS) return;
    loadedAt.current = Date.now();
    setSnapshot((current) => (current.state === 'ready' ? current : { state: 'loading' }));
    try {
      const result = await apiService.workspaces.get();
      const list = result.data.workspaces || [];
      const workspace = list.find((entry) => entry.active) || null;
      let files = [];
      if (workspace) {
        const response = await apiService.documents.get({
          purpose: 'workspace',
          workspaceId: workspace.id,
        });
        files = response.data.documents || [];
      }
      if (mounted.current) setSnapshot({ state: 'ready', workspace, files });
    } catch {
      loadedAt.current = 0; // try again on the next hover
      if (mounted.current) setSnapshot({ state: 'error' });
    }
  };

  const show = () => {
    clearTimeout(closeTimer.current);
    if (suppressed.current || position) return;
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Line the flyout up with the item, but slide it up when the window is short and
      // let it scroll inside whatever height is left, so no shortcut is ever off-screen.
      const top = Math.max(8, Math.min(rect.top - 6, window.innerHeight - FLYOUT_HEIGHT));
      setPosition({
        left: Math.min(rect.right + 8, Math.max(8, window.innerWidth - FLYOUT_WIDTH - 8)),
        top,
        maxHeight: window.innerHeight - top - 8,
      });
      load();
    }, 140);
  };

  const hide = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setPosition(null), 200);
  };

  const leave = () => {
    suppressed.current = false;
    hide();
  };

  const choose = (section) => {
    clearTimeout(openTimer.current);
    setPosition(null);
    suppressed.current = true;
    if (section) openWorkspace(section);
    else onOpen();
  };

  const Icon = item.icon;
  const workspace = snapshot.state === 'ready' ? snapshot.workspace : null;
  const files = snapshot.state === 'ready' ? snapshot.files : [];

  return (
    <div onMouseEnter={show} onMouseLeave={leave} onFocus={show} onBlur={hide}>
      <button
        ref={buttonRef}
        type="button"
        title={item.title}
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        aria-haspopup="menu"
        aria-expanded={!!position}
        onClick={() => choose(null)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setPosition(null);
        }}
        className={`flex h-10 w-full items-center rounded-xl text-xs font-semibold transition-all ${open ? 'gap-3 px-3' : 'justify-center'}`}
        style={{
          background: active
            ? `linear-gradient(135deg, ${accent}25, ${accent}05)`
            : position
              ? 'rgba(255,255,255,0.04)'
              : 'transparent',
          border: active ? `1px solid ${accent}35` : '1px solid transparent',
          color: active || position ? '#fff' : '#8b8b92',
        }}
      >
        <Icon size={16} style={{ color: active ? accent : undefined }} />
        {open && <span className="flex-1 text-left">{item.label}</span>}
        {open && <ChevronRight size={13} className="text-stone-600" />}
      </button>

      {position &&
        createPortal(
          <motion.div
            role="menu"
            aria-label="Workspace sections"
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.12 }}
            onMouseEnter={() => clearTimeout(closeTimer.current)}
            onMouseLeave={leave}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setPosition(null);
            }}
            className="fixed z-[60] overflow-y-auto rounded-2xl border border-white/[0.08] bg-[#121214]/95 p-2 text-stone-300 shadow-2xl backdrop-blur-xl"
            style={{
              left: position.left,
              top: position.top,
              maxHeight: position.maxHeight,
              width: FLYOUT_WIDTH,
              maxWidth: 'calc(100vw - 16px)',
            }}
          >
            {/* What is in the workspace right now */}
            <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] p-2.5">
              <div className="flex items-center gap-2">
                <Folder size={14} className="shrink-0" style={{ color: accent }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold text-stone-100">
                    {workspace ? workspace.name : 'Workspace'}
                  </div>
                  <div className="truncate text-[10px] text-stone-500">
                    {snapshot.state === 'loading' || snapshot.state === 'idle'
                      ? 'Loading…'
                      : snapshot.state === 'error'
                        ? 'Could not read the workspace'
                        : workspace
                          ? `${files.length} file${files.length === 1 ? '' : 's'} indexed`
                          : 'No workspace folder connected yet'}
                  </div>
                </div>
              </div>
              {files.length > 0 && (
                <ul className="mt-2 space-y-0.5" aria-label="Workspace files">
                  {files.slice(0, FLYOUT_FILES).map((file) => (
                    <li
                      key={file.id}
                      className="flex items-center gap-2 rounded-md px-1 py-0.5 text-[11px] text-stone-400"
                    >
                      <FileText size={11} className="shrink-0 text-stone-600" />
                      <span className="min-w-0 flex-1 truncate" title={file.name}>
                        {file.name}
                      </span>
                      {file.size ? (
                        <span className="shrink-0 text-[9px] text-stone-600">
                          {formatBytes(file.size)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                  {files.length > FLYOUT_FILES && (
                    <li className="px-1 pt-0.5 text-[10px] text-stone-600">
                      +{files.length - FLYOUT_FILES} more in Files
                    </li>
                  )}
                </ul>
              )}
            </div>

            {/* Shortcuts */}
            <div className="mt-1.5 space-y-0.5">
              {WORKSPACE_LINKS.map((link) => {
                const LinkIcon = link.icon;
                const count = link.id === 'knowledge' && documents.length ? documents.length : null;
                return (
                  <button
                    key={link.id}
                    type="button"
                    role="menuitem"
                    onClick={() => choose(link.id)}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:outline-none"
                  >
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                      style={{ background: `${accent}18` }}
                    >
                      <LinkIcon size={14} style={{ color: accent }} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold text-stone-100">
                        {link.label}
                      </span>
                      <span className="block truncate text-[10px] text-stone-500">{link.hint}</span>
                    </span>
                    {count ? (
                      <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] text-stone-400">
                        {count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </motion.div>,
          document.body,
        )}
    </div>
  );
}

export default function Sidebar() {
  const [open, setOpen] = useState(() => window.innerWidth >= 650);

  const tab = useNavStore((state) => state.tab);
  const setTab = useNavStore((state) => state.setTab);
  const openSettings = useNavStore((state) => state.openSettings);

  const user = useAppStore((state) => state.user);
  const logout = useAppStore((state) => state.logout);
  const conversations = useAppStore((state) => state.conversations);
  const activeChatId = useAppStore((state) => state.activeChatId);
  const generatingChats = useAppStore((state) => state.generatingChats);
  const selectChat = useAppStore((state) => state.selectChat);
  const createChat = useAppStore((state) => state.createChat);
  const fetchHistory = useAppStore((state) => state.fetchHistory);
  const settings = useAppStore((state) => state.settings);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Narrow windows get the icon rail automatically.
  useEffect(() => {
    const resize = () => {
      if (window.innerWidth < 650) setOpen(false);
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const accent = settings.accentColor || '#3b82f6';
  const displayName = user?.displayName || user?.username || '';
  const recent = conversations.slice(0, RECENT_LIMIT);

  const startNewChat = () => {
    createChat();
    setTab('chat');
  };

  return (
    <motion.aside
      animate={{ width: open ? 240 : 68 }}
      transition={presets.springSmooth}
      aria-label="Main navigation"
      className="relative z-20 flex h-full min-h-0 shrink-0 flex-col border-r border-white/[0.03] bg-[#0c0c0e]/60 backdrop-blur-xl"
    >
      {/* Brand + collapse */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.04] px-3">
        <button
          type="button"
          onClick={startNewChat}
          title="New conversation"
          className="flex items-center gap-2 overflow-hidden rounded-lg px-1 py-1"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
            style={{
              borderColor: `${accent}40`,
              background: `linear-gradient(135deg, ${accent}20, transparent)`,
            }}
          >
            <Sparkles size={14} style={{ color: accent }} />
          </span>
          {open && (
            <span className="whitespace-nowrap bg-gradient-to-r from-white to-stone-400 bg-clip-text text-sm font-extrabold tracking-widest text-transparent">
              CHANAKYA AI
            </span>
          )}
        </button>
        {open && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Collapse sidebar"
            className="rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-white/5 hover:text-white"
          >
            <PanelLeftClose size={15} />
          </button>
        )}
      </div>

      {/* Everything between the brand and the account card scrolls, so no item
          is ever cut off in a short window. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Expand sidebar"
            className="mx-auto mt-2 block rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-white/5 hover:text-white"
          >
            <PanelLeftOpen size={15} />
          </button>
        )}

        {/* New chat */}
        <div className="px-3 pt-3">
          <button
            type="button"
            onClick={startNewChat}
            title="New conversation"
            aria-label="New conversation"
            className={`flex h-10 w-full items-center rounded-xl border text-xs font-semibold text-white transition-all hover:brightness-125 ${open ? 'gap-2 px-3' : 'justify-center'}`}
            style={{
              borderColor: `${accent}40`,
              background: `linear-gradient(135deg, ${accent}30, ${accent}08)`,
            }}
          >
            <Plus size={16} style={{ color: accent }} />
            {open && <span>New chat</span>}
          </button>
        </div>

        {/* The four sections */}
        <nav className="space-y-1 p-3" aria-label="Sections">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            if (item.id === 'workspace') {
              return (
                <WorkspaceNavItem
                  key={item.id}
                  item={item}
                  open={open}
                  active={active}
                  accent={accent}
                  onOpen={() => setTab('workspace')}
                />
              );
            }
            return (
              <button
                key={item.id}
                type="button"
                title={item.title}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
                onClick={() => setTab(item.id)}
                className={`flex h-10 w-full items-center rounded-xl text-xs font-semibold transition-all ${open ? 'gap-3 px-3' : 'justify-center'}`}
                style={{
                  background: active
                    ? `linear-gradient(135deg, ${accent}25, ${accent}05)`
                    : 'transparent',
                  border: active ? `1px solid ${accent}35` : '1px solid transparent',
                  color: active ? '#fff' : '#8b8b92',
                }}
              >
                <Icon size={16} style={{ color: active ? accent : undefined }} />
                {open && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* Quick access to the latest conversations; the full list is History */}
        {open && recent.length > 0 && (
          <div className="px-3 pb-3">
            <div className="mb-1.5 border-t border-white/[0.04] px-2 pt-3 text-[9px] font-bold uppercase tracking-wider text-stone-600">
              Recent
            </div>
            <div className="space-y-0.5">
              {recent.map((chat) => {
                const active = tab === 'chat' && activeChatId === chat.id;
                return (
                  <button
                    key={chat.id}
                    type="button"
                    title={chat.title}
                    onClick={() => {
                      setTab('chat');
                      selectChat(chat.id);
                    }}
                    className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.04]"
                    style={{
                      color: active ? '#fff' : '#a8a29e',
                      background: active ? 'rgba(255,255,255,0.04)' : undefined,
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{chat.title || 'Untitled chat'}</span>
                    {generatingChats[chat.id] && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400"
                        title="Answering in the background"
                      />
                    )}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => setTab('history')}
              className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-[11px] text-stone-500 transition-colors hover:text-white"
            >
              View all history
            </button>
          </div>
        )}
      </div>

      {/* Account */}
      <div className="shrink-0 space-y-1.5 border-t border-white/[0.04] p-3">
        {user && (
          <button
            type="button"
            title="Profile"
            aria-label="Open profile"
            onClick={() => openSettings('profile')}
            className={`flex w-full items-center rounded-xl border border-white/[0.04] bg-[#121214]/40 py-2 text-left transition-colors hover:bg-white/[0.04] ${open ? 'gap-2.5 px-2.5' : 'justify-center'}`}
          >
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-black"
              style={{ background: accent }}
            >
              {displayName.charAt(0).toUpperCase()}
            </span>
            {open && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-stone-200">
                  {displayName}
                </span>
                <span className="block truncate text-[10px] text-stone-500">@{user.username}</span>
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={logout}
          title="Logout"
          aria-label="Logout"
          className={`flex w-full items-center rounded-xl border border-red-500/10 bg-red-500/[0.02] py-2 text-red-400/70 transition-all hover:bg-red-500/10 hover:text-red-400 ${open ? 'gap-2 px-3' : 'justify-center'}`}
        >
          <LogOut size={14} />
          {open && <span className="text-xs">Logout</span>}
        </button>
      </div>
    </motion.aside>
  );
}
