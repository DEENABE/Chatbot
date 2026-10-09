import { softwareTask } from './SoftwareTask.js';

const success = (event) => event?.success === true && event.data?.success !== false;
const details = (event) => event?.data || {};
const fail = (event) => ({
  success: false,
  message:
    event?.error?.message ||
    details(event).message ||
    'The software operation failed. No installation has been verified.',
});
const call = (action, params, note) => ({ call: { tool: 'software', action, params }, note });
const observed = (data) =>
  data.verification?.status === 'verified' &&
  Number.isFinite(Date.parse(data.verification.observedAt));
const handle = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
export function verifiedSoftwareInstall(data) {
  return (
    observed(data) &&
    ['INSTALL_VERIFIED', 'INSTALLED', 'ALREADY_INSTALLED'].includes(data.status) &&
    [
      'installed_inventory',
      'installed_identity',
      'app_registry',
      'winget_list',
      'provider_inventory',
    ].includes(data.verification?.criterion)
  );
}
export function verifiedSoftwareDownload(data) {
  return (
    observed(data) &&
    ['DOWNLOADED_VERIFIED', 'DOWNLOAD_COMPLETED'].includes(data.status) &&
    /^[a-f0-9]{64}$/i.test(data.sha256 || data.download?.sha256 || '')
  );
}

/** Bounded, deterministic replay. It accepts only service-issued opaque IDs, never model commands or URLs. */
function singleSoftwareDecision({
  task,
  admission = softwareTask(task),
  evidence = [],
  signal,
} = {}) {
  if (signal?.aborted) return { success: false, message: 'The software request was cancelled.' };
  if (!admission)
    return { success: false, message: 'This request has no admitted software operation.' };
  if (admission.blocked || admission.needsClarification || admission.highRisk)
    return { success: false, message: admission.message };
  const events = evidence.filter((event) => /^software_/.test(event?.toolName || ''));
  if (events.length > 16)
    return {
      success: false,
      message: 'The software operation reached its action limit before completion.',
    };
  const last = events.at(-1);
  if (last?.needsConfirmation)
    return {
      waiting: true,
      message: last.confirmationMessage || 'Review the software action and allow it once.',
    };
  if (last?.needsSoftwareChoice)
    return {
      waiting: true,
      needsSoftwareChoice: true,
      ...details(last),
      message:
        last.choiceMessage || details(last).message || 'Choose the exact product and publisher.',
    };
  if (last && !success(last)) return fail(last);
  if (!last)
    return call(
      'discover',
      { query: admission.query },
      'Checking installed providers and approved offline sources',
    );
  const discovery = events.findLast(
    (event) =>
      ['software_discover', 'software_discoverOnline'].includes(event.toolName) && success(event),
  );
  const data = details(last);
  if (
    [
      'software_discover',
      'software_discoverOnline',
      'software_chooseCandidate',
      'software_select',
    ].includes(last.toolName)
  ) {
    const found = details(discovery);
    const candidates = found.candidates || [];
    const humanChoice = ['software_chooseCandidate', 'software_select'].includes(last.toolName);
    if (humanChoice && data.discoveryId !== found.discoveryId)
      return {
        success: false,
        message: 'The selected product belongs to another discovery request. Start a fresh lookup.',
      };
    const selected = humanChoice
      ? data.selectedCandidateId || data.candidateId
      : !found.requiresChoice
        ? found.selectedCandidateId
        : null;
    if (handle(selected) && candidates.some((candidate) => candidate.candidateId === selected))
      return call('resolve', { candidateId: selected }, 'Resolving a validated installation plan');
    if (found.requiresChoice || candidates.length > 1)
      return {
        waiting: true,
        needsSoftwareChoice: true,
        discoveryId: found.discoveryId,
        candidates,
        message: 'Choose the exact software identity and publisher before preparing an installer.',
      };
    if (candidates.length === 1 && handle(candidates[0].candidateId))
      return call(
        'resolve',
        { candidateId: candidates[0].candidateId },
        'Resolving a validated installation plan',
      );
    if (last.toolName === 'software_discover' && found.requiresOnline === true)
      return call(
        'discoverOnline',
        { query: admission.query },
        'Requesting approval to search eligible online software sources',
      );
    const failures = (found.failures || [])
      .map((item) => `${item.providerId || 'Source'}: ${item.message || item.status}`)
      .join('; ');
    return {
      success: false,
      message:
        found.message ||
        `No verified installation method was found.${failures ? ` ${failures}` : ''} Add an approved source or choose a verified local installer.`,
    };
  }
  const resolved = events.findLast(
    (event) => event.toolName === 'software_resolve' && success(event),
  );
  const plan = details(resolved).plan || details(resolved);
  const planId = plan.planId || details(resolved).planId;
  if (!handle(planId))
    return {
      success: false,
      message: 'The backend did not issue a validated software plan. Nothing was installed.',
    };
  if (
    ['software_download', 'software_install', 'software_verify'].includes(last.toolName) &&
    data.planId !== planId
  )
    return {
      success: false,
      message:
        'The software result does not belong to the approved plan. Nothing has been verified.',
    };
  if (last.toolName === 'software_resolve') {
    if (
      ['HANDOFF_REQUIRED', 'USER_ASSISTED', 'NO_AUTOMATED_METHOD', 'HIGH_RISK_HANDOFF'].includes(
        data.status,
      ) ||
      plan.protocol === 'handoff'
    )
      return {
        success: false,
        message:
          data.message || 'This product requires its official user-assisted installation workflow.',
      };
    if (Array.isArray(plan.dependencies) && plan.dependencies.length > 0)
      return {
        success: false,
        message:
          'This installation has unresolved dependencies. Review and approve each required product separately before continuing.',
      };
    const downloadFirst = admission.query.operation === 'download' || plan.protocol === 'download';
    return call(
      downloadFirst ? 'download' : 'install',
      { planId },
      downloadFirst
        ? 'Requesting approval to download and verify the installer'
        : 'Requesting approval for this exact product and installation plan',
    );
  }
  if (last.toolName === 'software_download') {
    if (!verifiedSoftwareDownload(data))
      return {
        success: false,
        message: data.message || 'The installer download could not be independently verified.',
      };
    if (admission.query.operation === 'download')
      return {
        success: true,
        downloaded: true,
        message:
          data.message ||
          `${plan.name || admission.query.product}: the installer was downloaded and verified.`,
        planId,
      };
    if (!data.plan || data.plan.planId !== planId || data.plan.protocol !== 'local-installer')
      return {
        success: false,
        message: 'The downloaded package has no validated local installation plan. It was not run.',
      };
    if (Array.isArray(data.plan.dependencies) && data.plan.dependencies.length > 0)
      return {
        success: false,
        message:
          'The verified installer declares additional dependencies. Review and approve the required products separately before running it.',
      };
    return call(
      'install',
      { planId },
      'Requesting fresh approval for the staged installer, verified publisher, and required privileges',
    );
  }
  if (last.toolName === 'software_install') {
    if (data.needsReboot || data.status === 'INSTALLED_REBOOT_REQUIRED')
      return {
        success: false,
        pendingRestart: true,
        message:
          data.message ||
          'The installer requires a Windows restart; installation is not verified yet.',
      };
    return call('verify', { planId }, 'Checking fresh installed-software inventory');
  }
  if (last.toolName === 'software_verify')
    return verifiedSoftwareInstall(data)
      ? {
          success: true,
          message:
            data.message || `${admission.query.product} is independently verified as installed.`,
          planId,
        }
      : {
          success: false,
          message:
            data.message ||
            'The installer finished, but the requested product was not found in fresh installed-software inventory.',
        };
  return {
    success: false,
    message: 'The software operation returned an unexpected step; execution stopped.',
  };
}

/** Sequential batches retain separate candidate handles, plans, approvals, and inventory evidence. */
export function nextSoftwareDecision({
  task,
  admission = softwareTask(task),
  evidence = [],
  signal,
} = {}) {
  if (!admission || admission.blocked || admission.needsClarification || admission.highRisk)
    return singleSoftwareDecision({ task, admission, evidence, signal });
  const queries = admission.queries || [admission.query];
  if (!queries.length || queries.length > 8)
    return { success: false, message: 'The software batch needs between one and eight products.' };
  const events = evidence.filter((event) => /^software_/.test(event?.toolName || ''));
  const completed = [];
  let cursor = 0;
  for (const [itemIndex, query] of queries.entries()) {
    const current = [];
    let decision = singleSoftwareDecision({ task, admission: { query }, evidence: [], signal });
    while (cursor < events.length) {
      current.push(events[cursor++]);
      decision = singleSoftwareDecision({ task, admission: { query }, evidence: current, signal });
      if (decision.success === true || decision.success === false) break;
    }
    if (decision.success !== true)
      return {
        ...decision,
        itemIndex,
        totalProducts: queries.length,
        completedProducts: completed,
      };
    completed.push({
      product: query.product,
      operation: query.operation,
      message: decision.message,
      planId: decision.planId,
    });
  }
  return {
    success: true,
    downloaded: queries.every((query) => query.operation === 'download'),
    planId: completed.at(-1)?.planId,
    completedProducts: completed,
    message:
      queries.length === 1
        ? completed[0].message
        : completed.map((item) => `${item.product}: ${item.message}`).join('\n'),
  };
}
