import React from 'react';
import { useNavStore } from '../stores/useNavStore.js';
/** Existing model-settings entry now opens the same generic software workflow. */
export default function OfflineInstallerControls() {
  const openSettings = useNavStore((state) => state.openSettings);
  return (
    <section className="space-y-2 border-t border-white/10 pt-4">
      <h3 className="font-medium">Software installation</h3>
      <p className="text-xs text-stone-400">
        Use approved repositories or signed local installers through the shared software provider
        system.
      </p>
      <button
        type="button"
        className="rounded-lg border border-white/10 px-3 py-2 text-xs"
        onClick={() => openSettings('software')}
      >
        Manage software sources and installers
      </button>
    </section>
  );
}
