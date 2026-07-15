import React, { useEffect, useState } from 'react';
import { useAppStore } from '../stores/useAppStore.js';
import Welcome from './Welcome.jsx';
import MessageList from './MessageList.jsx';
import MemoryPanel from '../memory/MemoryPanel.jsx';
import SystemMonitor from '../dashboard/SystemMonitor.jsx';
import { 
  FileText, 
  Trash2, 
  UploadCloud, 
  Plus, 
  Tag, 
  Bookmark, 
  AlertCircle
} from 'lucide-react';

export default function ChatArea({ activeTab }) {
  const activeChatId = useAppStore((state) => state.activeChatId);
  const activeMessages = useAppStore((state) => state.activeMessages);
  const sendMessage = useAppStore((state) => state.sendMessage);
  
  const documents = useAppStore((state) => state.documents);
  const isUploadingDocs = useAppStore((state) => state.isUploadingDocs);
  const uploadProgress = useAppStore((state) => state.uploadProgress);
  const fetchDocuments = useAppStore((state) => state.fetchDocuments);
  const uploadDocuments = useAppStore((state) => state.uploadDocuments);
  const deleteDocument = useAppStore((state) => state.deleteDocument);
  const settings = useAppStore((state) => state.settings);

  useEffect(() => {
    if (activeTab === 'documents') {
      fetchDocuments();
    }
  }, [activeTab, fetchDocuments]);

  // Handle document drag & drop
  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    if (e.dataTransfer.files) {
      await uploadDocuments(e.dataTransfer.files);
    }
  };

  const handleFileChange = async (e) => {
    if (e.target.files) {
      await uploadDocuments(e.target.files);
    }
  };

  const accent = settings.accentColor || '#3b82f6';

  if (activeTab === 'documents') {
    return (
      <div 
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className="w-full h-full flex flex-col p-4 overflow-y-auto select-none"
      >
        <div className="mx-auto max-w-2xl w-full flex-1 flex flex-col space-y-4">
          <div>
            <h2 className="text-sm font-bold text-stone-200">Local Knowledge Base</h2>
            <p className="text-[10px] text-stone-500 mt-0.5">Documents uploaded here are chunked, embedded, and searched locally during conversation prompting.</p>
          </div>

          {/* Drag & Drop Area */}
          <label className="border border-dashed border-white/[0.08] bg-[#09090a]/30 rounded-2xl p-6 flex flex-col items-center justify-center cursor-pointer hover:bg-white/[0.02] hover:border-white/15 transition-all text-center">
            <input type="file" multiple onChange={handleFileChange} className="hidden" />
            <UploadCloud size={28} className="mb-2" style={{ color: accent }} />
            <span className="text-xs font-semibold text-stone-300">Drag & Drop files here, or click to browse</span>
            <span className="text-[9px] text-stone-600 mt-1">Supports PDF, DOCX, XLSX, CSV, TXT, MD up to 25MB</span>
          </label>

          {/* Uploading progress */}
          {isUploadingDocs && (
            <div className="border border-white/[0.05] bg-white/[0.02] rounded-xl p-3.5 space-y-1.5 animate-pulse">
              <div className="flex justify-between text-[10px] font-semibold text-stone-400">
                <span>Vectorizing documents...</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full transition-all duration-300" style={{ width: `${uploadProgress}%`, backgroundColor: accent }} />
              </div>
            </div>
          )}

          {/* Documents catalog list */}
          <div className="flex-1 flex flex-col min-h-0 space-y-2">
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-stone-600 mb-1">
              Indexed Files ({documents.length})
            </h3>
            {documents.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center border border-white/[0.04] bg-[#121214]/25 rounded-2xl p-8 text-center">
                <FileText size={24} className="text-stone-700 mb-2" />
                <div className="text-xs font-medium text-stone-500">No documents indexed</div>
                <div className="text-[10px] text-stone-600 mt-0.5">Upload a document to unlock private semantic RAG queries.</div>
              </div>
            ) : (
              <div className="space-y-1.5 overflow-y-auto max-h-[320px] pr-1">
                {documents.map((doc) => (
                  <div 
                    key={doc.id}
                    className="flex items-center justify-between border border-white/[0.04] bg-white/[0.01] rounded-xl p-2.5 hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="flex items-center gap-2 overflow-hidden mr-2">
                      <FileText size={15} style={{ color: accent }} className="shrink-0" />
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-stone-300">{doc.name}</div>
                        <div className="text-[9px] text-stone-600 mt-0.5">
                          {doc.size ? `${Math.round(doc.size / 1024)} KB` : 'Size N/A'} · {doc.chunks || '0'} chunks
                        </div>
                      </div>
                    </div>
                    <button 
                      onClick={() => deleteDocument(doc.id)}
                      className="rounded-lg p-1.5 text-stone-600 hover:bg-red-500/10 hover:text-red-400 transition-all cursor-pointer"
                      title="Remove document index"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (activeTab === 'memories') {
    return <MemoryPanel />;
  }

  if (activeTab === 'diagnostics') {
    return <SystemMonitor />;
  }

  // Fallback to chat messaging list
  return activeChatId || activeMessages.length > 0 ? (
    <MessageList />
  ) : (
    <Welcome onPrompt={(promptText) => sendMessage(promptText)} />
  );
}
