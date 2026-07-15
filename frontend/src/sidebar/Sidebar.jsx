import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Folder as FolderIcon,
  FolderPlus,
  Pin,
  Bookmark,
  Search,
  Plus,
  Trash2,
  Edit2,
  ChevronDown,
  ChevronRight,
  Settings,
  LogOut,
  User,
  Sparkles,
  FileText,
  Brain,
  Activity,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import SettingsModal from '../settings/SettingsModal.jsx';
import ProfileDetails from '../profile/ProfileDetails.jsx';
import { presets } from '../animations/presets.js';

export default function Sidebar({ activeTab, setActiveTab }) {
  const [open, setOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingFolderId, setEditingFolderId] = useState(null);
  const [expandedFolders, setExpandedFolders] = useState({});
  const [showProfile, setShowProfile] = useState(false);
  
  const user = useAppStore((state) => state.user);
  const logout = useAppStore((state) => state.logout);
  const conversations = useAppStore((state) => state.conversations);
  const folders = useAppStore((state) => state.folders);
  const activeChatId = useAppStore((state) => state.activeChatId);
  const selectChat = useAppStore((state) => state.selectChat);
  const createChat = useAppStore((state) => state.createChat);
  const deleteChat = useAppStore((state) => state.deleteChat);
  const renameChat = useAppStore((state) => state.renameChat);
  const pinChat = useAppStore((state) => state.pinChat);
  const bookmarkChat = useAppStore((state) => state.bookmarkChat);
  const moveChatToFolder = useAppStore((state) => state.moveChatToFolder);
  
  const createFolder = useAppStore((state) => state.createFolder);
  const renameFolder = useAppStore((state) => state.renameFolder);
  const deleteFolder = useAppStore((state) => state.deleteFolder);
  const fetchHistory = useAppStore((state) => state.fetchHistory);
  const settings = useAppStore((state) => state.settings);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const toggleFolder = (folderId) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [folderId]: !prev[folderId]
    }));
  };

  const handleCreateFolder = () => {
    const name = prompt('Enter folder name:');
    if (name?.trim()) {
      createFolder(name);
    }
  };

  const handleRenameFolder = (folderId, currentName) => {
    const name = prompt('Rename folder to:', currentName);
    if (name?.trim()) {
      renameFolder(folderId, name);
    }
  };

  const handleDeleteFolder = (folderId) => {
    if (confirm('Are you sure you want to delete this folder? Chats will not be deleted.')) {
      deleteFolder(folderId);
    }
  };

  const handleRenameChat = (chatId, currentTitle) => {
    const title = prompt('Rename conversation:', currentTitle);
    if (title?.trim()) {
      renameChat(chatId, title);
    }
  };

  const accent = settings.accentColor || '#3b82f6';

  // Filter conversations by search query
  const filteredConversations = conversations.filter((c) =>
    (c.title || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group conversations
  const pinnedChats = filteredConversations.filter((c) => c.isPinned);
  const bookmarkedChats = filteredConversations.filter((c) => c.isBookmarked);
  
  // Folder categorized conversations
  const getChatsInFolder = (folderId) => {
    return filteredConversations.filter((c) => c.folderId === folderId && !c.isPinned);
  };

  return (
    <motion.aside
      animate={{ width: open ? 260 : 70 }}
      transition={presets.springSmooth}
      className="relative z-20 flex h-full shrink-0 flex-col border-r border-white/[0.03] bg-[#0c0c0e]/60 backdrop-blur-xl"
    >
      {/* Sidebar Header */}
      <div className="flex h-14 items-center justify-between px-4 border-b border-white/[0.04]">
        <div className="flex items-center gap-2 overflow-hidden cursor-pointer" onClick={() => { createChat(); setActiveTab('chat'); }}>
          <div 
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border animate-[pulse_3s_infinite]"
            style={{ 
              borderColor: `${accent}40`, 
              background: `linear-gradient(135deg, ${accent}20, transparent)`
            }}
          >
            <Sparkles size={14} style={{ color: accent }} />
          </div>
          {open && (
            <span className="text-sm font-extrabold tracking-widest bg-gradient-to-r from-white to-stone-400 bg-clip-text text-transparent">
              CHANAKYA AI
            </span>
          )}
        </div>
        <button
          onClick={() => setOpen(!open)}
          className="rounded-lg p-1.5 text-stone-500 hover:bg-white/5 hover:text-white transition-colors"
        >
          {open ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </button>
      </div>

      {/* Main navigation icons */}
      <div className="space-y-1.5 p-3">
        <button
          onClick={() => { createChat(); setActiveTab('chat'); }}
          className="flex h-10 w-full items-center gap-3 rounded-xl px-3 transition-all text-xs font-semibold"
          style={{
            background: activeTab === 'chat' && !activeChatId ? `linear-gradient(135deg, ${accent}25, ${accent}05)` : 'transparent',
            border: activeTab === 'chat' && !activeChatId ? `1px solid ${accent}35` : '1px solid transparent',
            color: activeTab === 'chat' && !activeChatId ? '#fff' : '#888'
          }}
        >
          <Plus size={16} style={{ color: activeTab === 'chat' && !activeChatId ? accent : undefined }} />
          {open && <span>New conversation</span>}
        </button>

        <button
          onClick={() => setActiveTab('documents')}
          className="flex h-10 w-full items-center gap-3 rounded-xl px-3 transition-all text-xs font-semibold"
          style={{
            background: activeTab === 'documents' ? `linear-gradient(135deg, ${accent}25, ${accent}05)` : 'transparent',
            border: activeTab === 'documents' ? `1px solid ${accent}35` : '1px solid transparent',
            color: activeTab === 'documents' ? '#fff' : '#888'
          }}
        >
          <FileText size={16} style={{ color: activeTab === 'documents' ? accent : undefined }} />
          {open && <span>Knowledge base</span>}
        </button>

        <button
          onClick={() => setActiveTab('memories')}
          className="flex h-10 w-full items-center gap-3 rounded-xl px-3 transition-all text-xs font-semibold"
          style={{
            background: activeTab === 'memories' ? `linear-gradient(135deg, ${accent}25, ${accent}05)` : 'transparent',
            border: activeTab === 'memories' ? `1px solid ${accent}35` : '1px solid transparent',
            color: activeTab === 'memories' ? '#fff' : '#888'
          }}
        >
          <Brain size={16} style={{ color: activeTab === 'memories' ? accent : undefined }} />
          {open && <span>AI Memories</span>}
        </button>

        <button
          onClick={() => setActiveTab('diagnostics')}
          className="flex h-10 w-full items-center gap-3 rounded-xl px-3 transition-all text-xs font-semibold"
          style={{
            background: activeTab === 'diagnostics' ? `linear-gradient(135deg, ${accent}25, ${accent}05)` : 'transparent',
            border: activeTab === 'diagnostics' ? `1px solid ${accent}35` : '1px solid transparent',
            color: activeTab === 'diagnostics' ? '#fff' : '#888'
          }}
        >
          <Activity size={16} style={{ color: activeTab === 'diagnostics' ? accent : undefined }} />
          {open && <span>Diagnostics</span>}
        </button>
      </div>

      {open && <hr className="border-white/[0.04] mx-3 mb-2" />}

      {/* Folders and Recent List */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 overflow-y-auto px-3 space-y-4"
          >
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-600" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search history..."
                className="w-full rounded-xl border border-white/[0.05] bg-[#09090a]/50 py-1.5 pl-8 pr-3 text-xs text-stone-300 placeholder-stone-600 outline-none focus:border-white/10 focus:ring-0"
              />
            </div>

            {/* Pinned Chats */}
            {pinnedChats.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider text-stone-600 px-2 mb-1.5">
                  <Pin size={10} className="text-amber-500" />
                  <span>Pinned Conversations</span>
                </div>
                {pinnedChats.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    active={activeChatId === chat.id}
                    onSelect={() => { setActiveTab('chat'); selectChat(chat.id); }}
                    onRename={() => handleRenameChat(chat.id, chat.title)}
                    onPin={() => pinChat(chat.id, false)}
                    onBookmark={() => bookmarkChat(chat.id, !chat.isBookmarked)}
                    onDelete={() => deleteChat(chat.id)}
                    accent={accent}
                  />
                ))}
              </div>
            )}

            {/* Folders categorized */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-wider text-stone-600 px-2 mb-1.5">
                <span>Folders</span>
                <button onClick={handleCreateFolder} className="hover:text-white transition-colors" title="Create Folder">
                  <FolderPlus size={12} />
                </button>
              </div>

              {folders.map((folder) => {
                const folderChats = getChatsInFolder(folder.id);
                const isExpanded = expandedFolders[folder.id];
                return (
                  <div key={folder.id} className="space-y-1">
                    <div 
                      className="group flex items-center justify-between rounded-lg px-2 py-1.5 text-xs text-stone-500 hover:bg-white/[0.03] cursor-pointer"
                      onClick={() => toggleFolder(folder.id)}
                    >
                      <div className="flex items-center gap-1.5 overflow-hidden">
                        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        <FolderIcon size={13} style={{ color: accent }} />
                        <span className="truncate text-stone-400 font-medium">{folder.name}</span>
                      </div>
                      
                      {/* Folder settings */}
                      <div className="hidden group-hover:flex items-center gap-1.5">
                        <button onClick={(e) => { e.stopPropagation(); handleRenameFolder(folder.id, folder.name); }} title="Rename Folder">
                          <Edit2 size={11} className="hover:text-stone-300" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteFolder(folder.id); }} title="Delete Folder">
                          <Trash2 size={11} className="hover:text-red-400" />
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="pl-3 border-l border-white/[0.03] space-y-1 ml-3.5">
                        {folderChats.length === 0 ? (
                          <div className="text-[10px] text-stone-600 py-1 pl-2">Empty folder</div>
                        ) : (
                          folderChats.map((chat) => (
                            <ChatRow
                              key={chat.id}
                              chat={chat}
                              active={activeChatId === chat.id}
                              onSelect={() => { setActiveTab('chat'); selectChat(chat.id); }}
                              onRename={() => handleRenameChat(chat.id, chat.title)}
                              onPin={() => pinChat(chat.id, !chat.isPinned)}
                              onBookmark={() => bookmarkChat(chat.id, !chat.isBookmarked)}
                              onDelete={() => deleteChat(chat.id)}
                              accent={accent}
                              onMoveToFolder={(fid) => moveChatToFolder(chat.id, fid)}
                              folders={folders}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Uncategorized / Recent conversations */}
            <div className="space-y-1">
              <div className="text-[9px] font-bold uppercase tracking-wider text-stone-600 px-2 mb-1.5">
                <span>Recent Conversations</span>
              </div>
              {getChatsInFolder(null).map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  active={activeChatId === chat.id}
                  onSelect={() => { setActiveTab('chat'); selectChat(chat.id); }}
                  onRename={() => handleRenameChat(chat.id, chat.title)}
                  onPin={() => pinChat(chat.id, !chat.isPinned)}
                  onBookmark={() => bookmarkChat(chat.id, !chat.isBookmarked)}
                  onDelete={() => deleteChat(chat.id)}
                  accent={accent}
                  onMoveToFolder={(fid) => moveChatToFolder(chat.id, fid)}
                  folders={folders}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* User profile dropdown and Settings buttons */}
      <div className="mt-auto border-t border-white/[0.04] p-3 space-y-1">
        {/* User Card */}
        {user && open && (
          <div className="mb-2 flex items-center gap-2.5 rounded-xl border border-white/[0.04] bg-[#121214]/40 px-2.5 py-2">
            <div 
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-black"
              style={{ background: accent }}
            >
              {(user.displayName || user.username).charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-stone-200">{user.displayName || user.username}</div>
              <div className="truncate text-[10px] text-stone-500">@{user.username}</div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-1.5">
          <button
            onClick={() => setShowProfile(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/[0.04] bg-white/[0.02] py-2 text-stone-500 hover:bg-white/5 hover:text-white transition-all cursor-pointer"
            title="Profile details"
          >
            <User size={13} />
            {open && <span className="text-[10px] font-medium">Profile</span>}
          </button>
          
          <button
            onClick={() => setEditingFolderId('settings')}
            className="rounded-xl border border-white/[0.04] bg-white/[0.02] p-2 text-stone-500 hover:bg-white/5 hover:text-white transition-all"
            title="Settings"
          >
            <Settings size={14} />
          </button>
          
          <button
            onClick={logout}
            className="rounded-xl border border-red-500/10 bg-red-500/[0.02] p-2 text-red-400/60 hover:bg-red-500/10 hover:text-red-400 transition-all"
            title="Logout"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
      
      {/* Settings Modal */}
      <SettingsModal 
        open={editingFolderId === 'settings'} 
        onClose={() => setEditingFolderId(null)} 
      />

      {/* Profile Details Modal */}
      <AnimatePresence>
        {showProfile && (
          <ProfileDetails onClose={() => setShowProfile(false)} />
        )}
      </AnimatePresence>
    </motion.aside>
  );
}

// ChatRow Subcomponent
function ChatRow({
  chat,
  active,
  onSelect,
  onRename,
  onPin,
  onBookmark,
  onDelete,
  accent,
  onMoveToFolder,
  folders = []
}) {
  const [showOptions, setShowOptions] = useState(false);

  return (
    <div
      onMouseEnter={() => setShowOptions(true)}
      onMouseLeave={() => setShowOptions(false)}
      className="group relative flex items-center justify-between rounded-xl px-2 py-1.5 transition-all text-xs"
      style={{
        background: active ? `rgba(255, 255, 255, 0.03)` : 'transparent',
        border: active ? `1px solid rgba(255, 255, 255, 0.05)` : '1px solid transparent'
      }}
    >
      <button
        onClick={onSelect}
        className="flex-1 text-left truncate font-medium"
        style={{ color: active ? '#fff' : '#a8a29e' }}
      >
        {chat.title}
      </button>

      {/* Action buttons */}
      <div className={`flex items-center gap-1 ${showOptions ? 'opacity-100' : 'opacity-0'} transition-opacity ml-1.5 shrink-0 z-10 bg-inherit`}>
        <button onClick={onPin} title={chat.isPinned ? 'Unpin' : 'Pin'}>
          <Pin size={11} className={`${chat.isPinned ? 'text-amber-500' : 'text-stone-500'} hover:text-white`} />
        </button>
        <button onClick={onBookmark} title={chat.isBookmarked ? 'Remove Bookmark' : 'Bookmark'}>
          <Bookmark size={11} className={`${chat.isBookmarked ? 'text-amber-500' : 'text-stone-500'} hover:text-white`} />
        </button>

        {/* Move to folder dropdown selector */}
        {onMoveToFolder && folders.length > 0 && (
          <select
            onChange={(e) => {
              const val = e.target.value;
              onMoveToFolder(val === 'none' ? null : val);
            }}
            value={chat.folderId || 'none'}
            className="bg-[#09090a] border border-white/5 rounded text-[9px] text-stone-500 outline-none p-0.5"
            title="Move to Folder"
          >
            <option value="none">None</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        )}

        <button onClick={onRename} title="Rename">
          <Edit2 size={11} className="text-stone-500 hover:text-white" />
        </button>
        <button onClick={onDelete} title="Delete">
          <Trash2 size={11} className="text-stone-600 hover:text-red-400" />
        </button>
      </div>
    </div>
  );
}
