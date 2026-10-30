export const DOCUMENT_ACCEPT = '.pdf,.docx,.doc,.txt,.md,.csv,.tsv,.xlsx,.xlsm,.xls,.json';
export const ATTACHMENT_ACCEPT = `${DOCUMENT_ACCEPT},.png,.jpg,.jpeg,.webp`;
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_SIZE = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
const supported = new Set(ATTACHMENT_ACCEPT.split(','));
export function validateAttachment(file) {
  const extension = `.${String(file.name).split('.').pop().toLowerCase()}`;
  if (!supported.has(extension))
    return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(file.name)
      ? 'Image files require a compatible local vision model. Use screen capture when vision is available.'
      : 'Supported formats: PDF, DOCX, DOC, TXT, Markdown, CSV, TSV, XLSX, XLSM, XLS, JSON, PNG, JPEG and WebP. Images require a compatible local vision model.';
  if (!file.size) return 'This file is empty.';
  if (/\.(png|jpe?g|webp)$/i.test(file.name) && file.size > MAX_IMAGE_ATTACHMENT_SIZE)
    return 'This image exceeds the 10 MB upload limit.';
  if (file.size > MAX_ATTACHMENT_SIZE) return 'This file exceeds the 25 MB upload limit.';
  return null;
}
export function shouldLoadChatTools(task, attachments, continuation, classify) {
  if (continuation) return true;
  if (!classify(task)) return false;
  if (!attachments?.length) return true;
  return /^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:open|launch|start|close|install|download|update|upgrade|reinstall|uninstall|fix|repair|diagnose|check|turn|set|change|create|write|save|move|copy|delete|rename)\b/i.test(
    String(task).trim(),
  );
}
export function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil((bytes || 0) / 1024))} KB`;
}
export function parseMetadata(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
export function toolStatus(message) {
  let result;
  try {
    result = JSON.parse(message.content || '{}');
  } catch {
    result = {};
  }
  if (result.needsConfirmation) return 'Waiting for your approval';
  if (result.needsAppChoice) return 'Waiting for your application choice';
  if (result.success === false || result.error)
    return 'The action could not be completed. You can retry or check Diagnostics.';
  const name = message.tool_name || '';
  if (/^software_/.test(name)) {
    const data = result.data || {};
    if (
      ['INSTALL_VERIFIED', 'INSTALLED', 'ALREADY_INSTALLED'].includes(data.status) &&
      data.verification?.status === 'verified'
    )
      return 'Software installation verified';
    if (data.status === 'DOWNLOADED_VERIFIED') return 'Installer downloaded and verified';
    if (data.requiresChoice) return 'Choose the software identity';
    if (data.status === 'HANDOFF_REQUIRED') return 'User-assisted installation required';
    return 'Software discovery step completed';
  }
  if (/install|winget/i.test(name)) return 'Application installation step completed';
  if (/repair/i.test(name)) return 'System repair step completed';
  if (/launch|open/i.test(name)) return 'Application action completed';
  if (/file/i.test(name)) return 'File action completed';
  return 'System check completed';
}
