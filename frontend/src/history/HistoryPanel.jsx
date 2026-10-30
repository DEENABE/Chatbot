import React, { useMemo, useState } from 'react';
import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  Edit2,
  Folder as FolderIcon,
  FolderPlus,
  MessageSquare,
  Pin,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { useNavStore } from '../stores/useNavStore.js';

// Electron renderers do not implement window.prompt() / window.confirm(), so
// every rename, create and delete confirmation here is done inline.

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'saved', label: 'Bookmarked' },
];

function formatWhen(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function conversationText(chat) {
  const parts = [chat.title || ''];
  for (const message of chat.messages || []) {
    if (typeof message?.content === 'string') parts.push(message.content);
  }
  return parts.join('\n').toLowerCase();
}

const iconButton =
  'rounded-md p-1.5 text-stone-500 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/40';

/** Inline "Yes / No" confirmation used instead of window.confirm(). */
function ConfirmInline({ label, onYes, onNo }) {
  return (
    <div className="flex shrink-0 items-center gap-1 text-[11px]" role="group" aria-label={label}>
      <span className="text-red-300">{label}</span>
      <button
        type="button"
        onClick={onYes}
        className={`${iconButton} text-red-300 hover:text-red-200`}
        aria-label="Confirm delete"
      >
        <Check size={13} />
      </button>
      <button type="button" onClick={onNo} className={iconButton} aria-label="Cancel delete">
        <X size={13} />
      </button>
    </div>
  );
}

/** Single-line text editor used for chat and folder rename / folder create. */
function InlineEditor({ initial = '', placeholder, onSubmit, onCancel, label }) {
  const [value, setValue] = useState(initial);
  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    else onCancel();
  };
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        autoFocus
        aria-label={label}
        value={value}
        maxLength={120}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
      />
      <button type="submit" className={iconButton} aria-label="Save">
        <Check size={13} />
      </button>
      <button type="button" onClick={onCancel} className={iconButton} aria-label="Cancel">
        <X size={13} />
      </button>
    </form>
  );
}

function ChatItem({ chat, active, folders, accent, onOpen, nested = false }) {
  const renameChat = useAppStore((state) => state.renameChat);
  const deleteChat = useAppStore((state) => state.deleteChat);
  const pinChat = useAppStore((state) => state.pinChat);
  const bookmarkChat = useAppStore((state) => state.bookmarkChat);
  const moveChatToFolder = useAppStore((state) => state.moveChatToFolder);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const generating = useAppStore((state) => !!state.generatingChats[chat.id]);

  const count = chat.messages?.length || 0;
  const meta = [
    formatWhen(chat.updatedAt || chat.createdAt),
    count ? `${count} message${count === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className={`group flex items-center gap-2 rounded-xl border px-2.5 py-2 transition-colors ${nested ? 'ml-4' : ''}`}
      style={{
        borderColor: active ? `${accent}45` : 'rgba(255,255,255,0.04)',
        background: active ? `${accent}10` : 'rgba(255,255,255,0.015)',
      }}
    >
      <MessageSquare size={14} className="shrink-0 text-stone-500" />
      {editing ? (
        <InlineEditor
          initial={chat.title || ''}
          label="Conversation name"
          onSubmit={(title) => {
            renameChat(chat.id, title);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
          title={chat.title}
        >
          <span className="block truncate text-xs font-medium text-stone-200">
            {chat.title || 'Untitled chat'}
          </span>
          {generating ? (
            <span
              className="flex items-center gap-1.5 truncate text-[10px]"
              style={{ color: accent }}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                style={{ background: accent }}
              />
              Answering in the background…
            </span>
          ) : (
            meta && <span className="block truncate text-[10px] text-stone-600">{meta}</span>
          )}
        </button>
      )}

      {!editing && confirming && (
        <ConfirmInline
          label="Delete?"
          onYes={() => {
            deleteChat(chat.id);
            setConfirming(false);
          }}
          onNo={() => setConfirming(false)}
        />
      )}

      {!editing && !confirming && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            className={iconButton}
            onClick={() => pinChat(chat.id, !chat.isPinned)}
            aria-label={chat.isPinned ? 'Unpin conversation' : 'Pin conversation'}
            title={chat.isPinned ? 'Unpin' : 'Pin'}
          >
            <Pin size={12} className={chat.isPinned ? 'text-amber-400' : undefined} />
          </button>
          <button
            type="button"
            className={iconButton}
            onClick={() => bookmarkChat(chat.id, !chat.isBookmarked)}
            aria-label={chat.isBookmarked ? 'Remove bookmark' : 'Bookmark conversation'}
            title={chat.isBookmarked ? 'Remove bookmark' : 'Bookmark'}
          >
            <Bookmark size={12} className={chat.isBookmarked ? 'text-amber-400' : undefined} />
          </button>
          {folders.length > 0 && (
            <select
              aria-label="Move conversation to folder"
              title="Move to folder"
              value={chat.folderId || 'none'}
              onChange={(event) =>
                moveChatToFolder(chat.id, event.target.value === 'none' ? null : event.target.value)
              }
              className="max-w-[88px] rounded-md border border-white/10 bg-[#0c0c0e] px-1 py-0.5 text-[10px] text-stone-400 outline-none"
            >
              <option value="none">No folder</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={iconButton}
            onClick={() => setEditing(true)}
            aria-label="Rename conversation"
            title="Rename"
          >
            <Edit2 size={12} />
          </button>
          <button
            type="button"
            className={`${iconButton} hover:text-red-400`}
            onClick={() => setConfirming(true)}
            aria-label="Delete conversation"
            title="Delete"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function FolderHeader({ folder, count, expanded, onToggle, accent }) {
  const renameFolder = useAppStore((state) => state.renameFolder);
  const deleteFolder = useAppStore((state) => state.deleteFolder);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
      {editing ? (
        <InlineEditor
          initial={folder.name}
          label="Folder name"
          onSubmit={(name) => {
            renameFolder(folder.id, name);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {expanded ? (
            <ChevronDown size={13} className="text-stone-500" />
          ) : (
            <ChevronRight size={13} className="text-stone-500" />
          )}
          <FolderIcon size={14} style={{ color: accent }} />
          <span className="truncate text-xs font-semibold text-stone-300">{folder.name}</span>
          <span className="text-[10px] text-stone-600">{count}</span>
        </button>
      )}
      {!editing && confirming && (
        <ConfirmInline
          label="Delete folder? Chats are kept."
          onYes={() => {
            deleteFolder(folder.id);
            setConfirming(false);
          }}
          onNo={() => setConfirming(false)}
        />
      )}
      {!editing && !confirming && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            className={iconButton}
            onClick={() => setEditing(true)}
            aria-label={`Rename folder ${folder.name}`}
            title="Rename folder"
          >
            <Edit2 size={12} />
          </button>
          <button
            type="button"
            className={`${iconButton} hover:text-red-400`}
            onClick={() => setConfirming(true)}
            aria-label={`Delete folder ${folder.name}`}
            title="Delete folder"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

export default function HistoryPanel() {
  const conversations = useAppStore((state) => state.conversations);
  const folders = useAppStore((state) => state.folders);
  const activeChatId = useAppStore((state) => state.activeChatId);
  const isHistoryLoading = useAppStore((state) => state.isHistoryLoading);
  const selectChat = useAppStore((state) => state.selectChat);
  const createChat = useAppStore((state) => state.createChat);
  const createFolder = useAppStore((state) => state.createFolder);
  const settings = useAppStore((state) => state.settings);
  const setTab = useNavStore((state) => state.setTab);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState({});
  const [creatingFolder, setCreatingFolder] = useState(false);

  const accent = settings.accentColor || '#3b82f6';
  const needle = query.trim().toLowerCase();
  const flat = needle !== '' || filter !== 'all';

  const visible = useMemo(() => {
    return conversations.filter((chat) => {
      if (filter === 'pinned' && !chat.isPinned) return false;
      if (filter === 'saved' && !chat.isBookmarked) return false;
      if (needle && !conversationText(chat).includes(needle)) return false;
      return true;
    });
  }, [conversations, filter, needle]);

  const open = (chat) => {
    selectChat(chat.id);
    setTab('chat');
  };

  const startNewChat = () => {
    createChat();
    setTab('chat');
  };

  const row = (chat, nested = false) => (
    <ChatItem
      key={chat.id}
      chat={chat}
      nested={nested}
      active={activeChatId === chat.id}
      folders={folders}
      accent={accent}
      onOpen={() => open(chat)}
    />
  );

  const pinned = visible.filter((chat) => chat.isPinned);
  const unfiled = visible.filter((chat) => !chat.isPinned && !chat.folderId);
  const inFolder = (folderId) =>
    visible.filter((chat) => !chat.isPinned && chat.folderId === folderId);

  return (
    <div className="h-full overflow-y-auto p-4 text-stone-300">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">History</h2>
            <p className="mt-1 text-xs text-stone-500">
              {conversations.length} conversation{conversations.length === 1 ? '' : 's'} saved on
              this device.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreatingFolder(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-stone-300 hover:bg-white/10"
          >
            <FolderPlus size={13} />
            New folder
          </button>
        </div>

        {creatingFolder && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2.5">
            <InlineEditor
              label="New folder name"
              placeholder="Folder name"
              onSubmit={(name) => {
                createFolder(name);
                setCreatingFolder(false);
              }}
              onCancel={() => setCreatingFolder(false)}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-600" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search titles and messages…"
              aria-label="Search history"
              className="w-full rounded-xl border border-white/[0.06] bg-[#09090a]/50 py-2 pl-8 pr-3 text-xs text-stone-200 outline-none placeholder:text-stone-600 focus:border-white/20"
            />
          </div>
          <div className="flex gap-1" role="group" aria-label="Filter conversations">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
                className={`rounded-lg px-3 py-2 text-xs transition-colors ${filter === item.id ? 'bg-white/10 text-white' : 'text-stone-500 hover:text-white'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {conversations.length === 0 && (
          <div className="rounded-2xl border border-white/[0.05] bg-[#121214]/30 p-8 text-center">
            <MessageSquare size={24} className="mx-auto mb-2 text-stone-700" />
            <div className="text-xs font-medium text-stone-400">
              {isHistoryLoading ? 'Loading conversations…' : 'No conversations yet'}
            </div>
            {!isHistoryLoading && (
              <button
                type="button"
                onClick={startNewChat}
                className="mt-3 rounded-lg border border-white/10 px-3 py-2 text-xs text-stone-300 hover:bg-white/10"
              >
                Start a chat
              </button>
            )}
          </div>
        )}

        {conversations.length > 0 && visible.length === 0 && (
          <p className="py-6 text-center text-xs text-stone-500">
            No conversations match your search.
          </p>
        )}

        {/* Search / filter results are one flat list */}
        {flat && visible.length > 0 && (
          <div className="space-y-1.5">{visible.map((chat) => row(chat))}</div>
        )}

        {/* Default view: pinned, folders, everything else */}
        {!flat && visible.length > 0 && (
          <div className="space-y-4">
            {pinned.length > 0 && (
              <section className="space-y-1.5" aria-label="Pinned conversations">
                <h3 className="flex items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wider text-stone-600">
                  <Pin size={10} className="text-amber-400" /> Pinned
                </h3>
                {pinned.map((chat) => row(chat))}
              </section>
            )}

            {folders.length > 0 && (
              <section className="space-y-1" aria-label="Folders">
                <h3 className="px-1 text-[10px] font-bold uppercase tracking-wider text-stone-600">
                  Folders
                </h3>
                {folders.map((folder) => {
                  const chats = inFolder(folder.id);
                  const isOpen = Boolean(expanded[folder.id]);
                  return (
                    <div key={folder.id} className="space-y-1.5">
                      <FolderHeader
                        folder={folder}
                        count={chats.length}
                        expanded={isOpen}
                        accent={accent}
                        onToggle={() =>
                          setExpanded((prev) => ({ ...prev, [folder.id]: !prev[folder.id] }))
                        }
                      />
                      {isOpen &&
                        (chats.length ? (
                          chats.map((chat) => row(chat, true))
                        ) : (
                          <p className="ml-8 text-[11px] text-stone-600">Empty folder</p>
                        ))}
                    </div>
                  );
                })}
              </section>
            )}

            {unfiled.length > 0 && (
              <section className="space-y-1.5" aria-label="Recent conversations">
                <h3 className="px-1 text-[10px] font-bold uppercase tracking-wider text-stone-600">
                  Recent
                </h3>
                {unfiled.map((chat) => row(chat))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
