import React, { Suspense } from 'react';
import {
  Activity,
  Brain,
  Code2,
  FolderOpen,
  Info,
  Languages,
  Library,
  ShieldCheck,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore.js';
import { useNavStore } from '../stores/useNavStore.js';
import ChatArea from '../chat/ChatArea.jsx';
import DiagnosticLog from '../settings/DiagnosticLog.jsx';

const CodingPanel = React.lazy(() => import('../coding/CodingPanel.jsx'));

// Everything that is "about your stuff" rather than "the conversation" lives
// here: local folders, saved knowledge, memories, the translator, app
// permissions and diagnostics. `panel` is the ChatArea view that renders it.
const SECTIONS = [
  { id: 'files', label: 'Files', icon: FolderOpen, panel: 'workspace' },
  { id: 'coding', label: 'Coding', icon: Code2 },
  { id: 'knowledge', label: 'Knowledge', icon: Library, panel: 'documents' },
  { id: 'memories', label: 'Memories', icon: Brain, panel: 'memories' },
  { id: 'translator', label: 'Translator', icon: Languages, panel: 'translator' },
  { id: 'apps', label: 'Apps', icon: ShieldCheck, panel: 'apps' },
  { id: 'diagnostics', label: 'Diagnostics', icon: Activity, panel: 'diagnostics' },
];

export default function WorkspaceHub() {
  const workspaceTab = useNavStore((state) => state.workspaceTab);
  const setWorkspaceTab = useNavStore((state) => state.setWorkspaceTab);
  const settings = useAppStore((state) => state.settings);
  const accent = settings.accentColor || '#3b82f6';
  const section = SECTIONS.find((item) => item.id === workspaceTab) || SECTIONS[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Workspace sections"
        className="flex shrink-0 flex-wrap gap-1 border-b border-white/[0.05] px-3 py-2"
      >
        {SECTIONS.map((item) => {
          const Icon = item.icon;
          const active = item.id === section.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`workspace-tab-${item.id}`}
              aria-selected={active}
              aria-controls="workspace-panel"
              onClick={() => setWorkspaceTab(item.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3 sm:py-2 ${active ? 'bg-white/10 text-white' : 'text-stone-500 hover:text-white'}`}
              style={active ? { boxShadow: `inset 0 -2px 0 ${accent}` } : undefined}
            >
              <Icon size={13} style={{ color: active ? accent : undefined }} />
              {item.label}
            </button>
          );
        })}
      </div>

      <div
        id="workspace-panel"
        role="tabpanel"
        aria-labelledby={`workspace-tab-${section.id}`}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {section.id === 'knowledge' && (
          <div className="mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] leading-4 text-stone-400">
            <Info size={13} className="mt-0.5 shrink-0" style={{ color: accent }} />
            <span>
              Knowledge is shared with every chat. A file attached with the paperclip in a chat
              belongs to that message only and is not added here.
            </span>
          </div>
        )}
        {section.id === 'coding' ? (
          <Suspense fallback={<p className="p-4 text-xs text-stone-400">Loading Coding Agent…</p>}>
            <CodingPanel />
          </Suspense>
        ) : section.id === 'diagnostics' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ChatArea activeTab="diagnostics" />
            <DiagnosticLog />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatArea activeTab={section.panel} />
          </div>
        )}
      </div>
    </div>
  );
}
