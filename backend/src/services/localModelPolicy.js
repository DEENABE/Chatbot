/** A loopback Ollama server can proxy cloud models; those are not local inference. */
export function isRemoteModel(model) {
  if (!model || typeof model !== 'object') return true;
  return Boolean(
    model.remote ||
    model.cloud ||
    model.remote_host ||
    model.remote_model ||
    model.remoteHost ||
    model.remoteModel ||
    model.details?.remote ||
    model.details?.remote_host ||
    model.details?.remote_model ||
    model.capabilities?.some?.((cap) => ['cloud', 'remote'].includes(cap)) ||
    /(?:^|[:.-])cloud(?:$|[:.-])/i.test(model.id || model.name || ''),
  );
}
