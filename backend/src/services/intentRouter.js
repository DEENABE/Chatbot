/**
 * Rules-based intent router: decides which logical agent a request belongs to, so the model router can pick the
 * model that suits that agent. Pure and synchronous: no model call, no I/O, no tool access.
 *
 * Security invariant: this module never decides whether computer tools are allowed. `requiresTools` is copied from
 * the `computerRequest` that the existing admission policy (ComputerTaskPolicy.computerTask) already produced, so a
 * request without computerRequest can only ever get an agent that runs on the tool-free "general" route.
 * `requiresApproval` is advisory (for display/telemetry); approval itself is enforced per tool by the existing
 * ToolPermissionPolicy / ConfirmationGate, which this module does not touch.
 */

// A symptom, not a how-to: "my printer is not working", "wifi keeps disconnecting".
const SYMPTOM =
  /\b(?:not working|isn'?t working|doesn'?t work|does not work|won'?t (?:start|open|connect|turn on|print|boot|load)|stopped working|keeps? (?:crashing|freezing|disconnecting)|crash(?:es|ing|ed)|freez(?:e|es|ing)|frozen|blue screen|bsod|too slow|very slow|running slow|no (?:sound|audio|internet|wi-?fi|display|signal)|can'?t (?:connect|print|hear|boot|install)|cannot (?:connect|print|boot)|not (?:connecting|printing|responding|detected|opening|starting)|troubleshoot|diagnos(?:e|is))\b/i;
// Something that belongs to the PC itself (app names such as Excel/Word are deliberately not here).
const PC_SUBJECT =
  /\b(?:windows|pc|laptop|computer|printer|printing|spooler|wi-?fi|internet|network|bluetooth|driver|audio|sound|speaker|microphone|display|monitor|screen|battery|usb|keyboard|mouse|disk|boot|startup|windows update|taskbar|explorer|outlook|onedrive|camera|webcam)\b/i;
const REPAIR_COMMAND = /\b(?:fix|repair|troubleshoot|diagnos(?:e|is)|resolve)\b/i;
const MUTATING =
  /\b(?:install|uninstall|delete|remove|change|set|turn|enable|disable|close|click|type|write|save|create|rename|move|copy|paste|update|upgrade|download|press|drag|restart|shut ?down|kill|stop)\b/i;

const GENERAL_CAPABILITIES = Object.freeze(['completion']);
const TOOL_CAPABILITIES = Object.freeze(['completion', 'tools']);

const result = ({
  intent,
  agentId,
  confidence,
  basis,
  requiresTools = false,
  hasImages = false,
  requiresApproval = false,
}) => ({
  intent,
  agentId,
  requiredCapabilities: [
    ...(requiresTools ? TOOL_CAPABILITIES : GENERAL_CAPABILITIES),
    ...(hasImages && !requiresTools ? ['vision'] : []),
  ],
  confidence,
  requiresTools,
  requiresApproval,
  basis,
});

const looksLikeRepair = (text) =>
  (SYMPTOM.test(text) || REPAIR_COMMAND.test(text)) && PC_SUBJECT.test(text);
// With computer tools in play, a bare "fix" is too vague (it could be a settings change): require a stronger signal.
const looksLikeToolRepair = (text) =>
  PC_SUBJECT.test(text) &&
  (SYMPTOM.test(text) ||
    /\b(?:repair|spooler)\b/i.test(text) ||
    (/\bfix\b/i.test(text) &&
      /\b(?:printer|printing|wi-?fi|internet|network|bluetooth|driver|sound|audio|usb)\b/i.test(
        text,
      )));

/**
 * @param {object} input
 * @param {string} input.message - the user's request (original task text).
 * @param {object|null} [input.computerRequest] - result of the existing computerTask() admission, or null/undefined.
 * @param {boolean} [input.hasAttachments]
 * @param {boolean} [input.hasImages]
 * @param {boolean} [input.wantsKnowledge] - the person asked about their workspace documents by name.
 * @returns {{intent:string, agentId:string, requiredCapabilities:string[], confidence:number,
 *   requiresTools:boolean, requiresApproval:boolean, basis:string}}
 */
export function classifyIntent({
  message = '',
  computerRequest = null,
  hasAttachments = false,
  hasImages = false,
  wantsKnowledge = false,
} = {}) {
  const text = String(message || '');

  if (computerRequest) {
    const mutating = MUTATING.test(text);
    if (computerRequest.software || computerRequest.requiresSoftware)
      return result({
        intent: 'software_install',
        agentId: 'software-install',
        confidence: 0.95,
        basis: 'admission:software',
        requiresTools: true,
        requiresApproval: true,
      });
    if (looksLikeToolRepair(text))
      return result({
        intent: 'windows_repair',
        agentId: 'windows-repair',
        confidence: 0.8,
        basis: 'keyword:repair',
        requiresTools: true,
        requiresApproval: true,
      });
    if (
      computerRequest.astra ||
      computerRequest.genericDesktop ||
      computerRequest.requiresUI ||
      computerRequest.requiresBrowser ||
      computerRequest.call?.tool === 'uiAutomation'
    )
      return result({
        intent: 'app_automation',
        agentId: 'app-automation',
        confidence: 0.9,
        basis: 'admission:ui',
        requiresTools: true,
        requiresApproval: mutating,
      });
    return result({
      intent: 'os_control',
      agentId: 'os-control',
      confidence: 0.85,
      basis: 'admission:computer-task',
      requiresTools: true,
      requiresApproval: mutating,
    });
  }

  if (hasImages)
    return result({
      intent: 'image_understanding',
      agentId: 'document-intelligence',
      confidence: 0.9,
      basis: 'attachment:image',
      hasImages: true,
    });
  if (hasAttachments)
    return result({
      intent: 'document_qa',
      agentId: 'document-intelligence',
      confidence: 0.9,
      basis: 'attachment:document',
    });
  if (wantsKnowledge)
    return result({
      intent: 'document_qa',
      agentId: 'document-intelligence',
      confidence: 0.75,
      basis: 'keyword:workspace-documents',
    });
  if (looksLikeRepair(text))
    return result({
      intent: 'windows_repair',
      agentId: 'windows-repair',
      confidence: 0.7,
      basis: 'keyword:symptom',
    });
  return result({
    intent: 'general_chat',
    agentId: 'general-chat',
    confidence: 0.6,
    basis: 'default',
  });
}

/** The full TaskRoute: the classification plus the models the model router chose for it. */
export const toTaskRoute = (classification, routing) => ({
  intent: classification.intent,
  agentId: classification.agentId,
  requiredCapabilities: classification.requiredCapabilities,
  confidence: classification.confidence,
  selectedModel: routing?.model ?? null,
  fallbackModel: routing?.fallbackModel ?? null,
  requiresTools: classification.requiresTools,
  requiresApproval: classification.requiresApproval,
});
