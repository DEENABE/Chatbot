import test from 'node:test';
import assert from 'node:assert/strict';
import { softwareTask, validSoftwareQuery } from '../src/orchestrator/SoftwareTask.js';
import { computerTask } from '../src/orchestrator/ComputerTaskPolicy.js';
import { nextSoftwareDecision } from '../src/orchestrator/SoftwareRunner.js';
import { clearAstraPlans, nextAstraDecision } from '../src/orchestrator/AstraRunner.js';
import {
  validateCapability,
  verificationPredicates,
} from '../src/orchestrator/CapabilityContracts.js';
import { shouldLoadChatTools, toolStatus } from '../../frontend/src/utils/attachments.js';
import { runOrchestrator } from '../src/orchestrator/AgentOrchestrator.js';
import { verifyOutcome } from '../src/orchestrator/Verifier.js';
import { routeTask } from '../src/orchestrator/TaskRouter.js';

const task = 'install Previously Unknown Future Software Product';
const candidateId = 'candidate_123456',
  planId = 'plan_12345678',
  discoveryId = 'discovery_12345';
const event = (action, data, success = true) => ({
  toolName: `software_${action}`,
  success,
  data: { success, ...data },
});
const discover = event('discover', {
  status: 'CANDIDATES_FOUND',
  discoveryId,
  candidates: [
    {
      candidateId,
      name: 'Previously Unknown Future Software Product',
      publisher: 'Independent Publisher',
    },
  ],
  selectedCandidateId: candidateId,
});
const resolve = event('resolve', {
  status: 'PLAN_READY',
  plan: {
    planId,
    name: 'Previously Unknown Future Software Product',
    publisher: 'Independent Publisher',
    protocol: 'msi',
  },
});
const verified = {
  status: 'verified',
  criterion: 'installed_inventory',
  observedAt: new Date().toISOString(),
};

test('unknown long names and specified requirements enter the Windows software route without a model', () => {
  for (const operation of ['install', 'download', 'update', 'reinstall']) {
    const admitted = computerTask(
      `${operation} Previously Unknown Future Software Product version 2.7 for arm64`,
    );
    assert.equal(admitted.software.query.operation, operation);
    assert.equal(admitted.software.query.product, 'Previously Unknown Future Software Product');
    assert.equal(admitted.software.query.version, '2.7');
    assert.equal(admitted.software.query.architecture, 'arm64');
    assert.equal(validSoftwareQuery(admitted.software.query), true);
    assert.equal(
      shouldLoadChatTools(
        `${operation} Previously Unknown Future Software Product`,
        [{}],
        null,
        computerTask,
      ),
      true,
    );
  }
  assert.equal(softwareTask('how do I install Previously Unknown Future Software Product'), null);
});
test('literal publisher/product punctuation stays data and fast task routing admits unknown products', async () => {
  const admitted = softwareTask('install Research & Design Studio by Creator & Partners');
  assert.equal(admitted.query.product, 'Research & Design Studio');
  assert.equal(admitted.query.publisher, 'Creator & Partners');
  assert.equal(validSoftwareQuery(admitted.query), true);
  assert.equal((await routeTask(task)).taskType, 'software_management');
});
test('batch identity, local installer paths, command text and high-risk OS operations cannot silently execute', () => {
  assert.deepEqual(
    softwareTask('install Future Product and Other Product').queries.map((query) => query.product),
    ['Future Product', 'Other Product'],
  );
  assert.equal(
    softwareTask('install Future Product from C:\\ApprovedInstallers').needsLocalSelection,
    true,
  );
  assert.equal(
    softwareTask('install Future Product; Remove-Item C:\\Data').needsClarification,
    true,
  );
  assert.equal(softwareTask('download operating system installer').needsClarification, true);
  assert.equal(softwareTask('install Future operating system').highRisk, true);
  assert.equal(softwareTask('install Future Product and type hello'), null);
  assert.equal(softwareTask('download Future Product and open it').needsClarification, true);
});
test('missing offline candidates ask for network permission before searching online', () => {
  const empty = event('discover', {
    discoveryId,
    candidates: [],
    requiresOnline: true,
    failures: [{ providerId: 'missing-manager', message: 'Not installed' }],
  });
  assert.equal(nextSoftwareDecision({ task }).call.action, 'discover');
  assert.equal(nextSoftwareDecision({ task, evidence: [empty] }).call.action, 'discoverOnline');
  assert.equal(
    nextSoftwareDecision({
      task,
      evidence: [
        empty,
        {
          toolName: 'software_discoverOnline',
          needsConfirmation: true,
          confirmationMessage: 'Allow network lookup?',
        },
      ],
    }).waiting,
    true,
  );
});
test('offline handoff candidates defer to eligible online installation sources', () => {
  const fallback = event('discover', {
    discoveryId,
    requiresOnline: true,
    candidates: [{ candidateId, name: 'Future Product', handoff: true }],
    selectedCandidateId: candidateId,
  });
  assert.equal(nextSoftwareDecision({ task, evidence: [fallback] }).call.action, 'discoverOnline');
  const onlineFallback = event('discoverOnline', { ...fallback.data, requiresOnline: false });
  assert.equal(
    nextSoftwareDecision({ task, evidence: [fallback, onlineFallback] }).call.action,
    'resolve',
  );
  const ended = nextSoftwareDecision({
    task,
    evidence: [
      fallback,
      onlineFallback,
      event('resolve', {
        status: 'HANDOFF_REQUIRED',
        plan: { planId, protocol: 'handoff' },
        message: 'No installation package was found. Choose a signed local installer.',
      }),
    ],
  });
  assert.equal(ended.success, false);
  assert.match(ended.message, /signed local installer/);
});
test('one trusted candidate resolves a typed plan and waits for install approval', () => {
  assert.deepEqual(nextSoftwareDecision({ task, evidence: [discover] }).call.params, {
    candidateId,
  });
  assert.deepEqual(nextSoftwareDecision({ task, evidence: [discover, resolve] }).call, {
    tool: 'software',
    action: 'install',
    params: { planId },
  });
  assert.equal(
    nextSoftwareDecision({
      task,
      evidence: [discover, resolve, { toolName: 'software_install', needsConfirmation: true }],
    }).waiting,
    true,
  );
});
test('installer exit success requires separate fresh inventory evidence', () => {
  const install = event('install', { status: 'INSTALLED', planId, exitCode: 0 });
  assert.equal(
    nextSoftwareDecision({ task, evidence: [discover, resolve, install] }).call.action,
    'verify',
  );
  assert.equal(
    nextSoftwareDecision({
      task,
      evidence: [
        discover,
        resolve,
        install,
        event('verify', {
          status: 'INSTALL_NOT_VERIFIED',
          planId,
          verification: { status: 'unverified' },
        }),
      ],
    }).success,
    false,
  );
  assert.equal(
    nextSoftwareDecision({
      task,
      evidence: [
        discover,
        resolve,
        install,
        event('verify', { status: 'INSTALL_VERIFIED', planId, verification: verified }),
      ],
    }).success,
    true,
  );
  assert.equal(verificationPredicates['software.install'](install.data, { planId }), false);
});
test('download-only resolves and downloads without any install or desktop call', () => {
  const downloadTask = 'download Previously Unknown Future Software Product';
  assert.equal(
    nextSoftwareDecision({ task: downloadTask, evidence: [discover, resolve] }).call.action,
    'download',
  );
  const receipt = event('download', {
    status: 'DOWNLOADED_VERIFIED',
    planId,
    sha256: 'a'.repeat(64),
    verification: { ...verified, criterion: 'package_file' },
  });
  assert.equal(
    nextSoftwareDecision({ task: downloadTask, evidence: [discover, resolve, receipt] }).success,
    true,
  );
  assert.equal(
    toolStatus({ tool_name: 'software_download', content: JSON.stringify(receipt) }),
    'Installer downloaded and verified',
  );
});
test('ambiguous products require an exact human choice belonging to this discovery', () => {
  const ambiguous = event('discover', {
    ...discover.data,
    requiresChoice: true,
    candidates: [
      ...discover.data.candidates,
      { candidateId: 'candidate_second', name: 'Other Product', publisher: 'Other Publisher' },
    ],
  });
  assert.equal(nextSoftwareDecision({ task, evidence: [ambiguous] }).needsSoftwareChoice, true);
  assert.equal(
    nextSoftwareDecision({
      task,
      evidence: [
        ambiguous,
        event('chooseCandidate', { discoveryId: 'another_discovery', candidateId }),
      ],
    }).success,
    false,
  );
  assert.equal(
    nextSoftwareDecision({
      task,
      evidence: [ambiguous, event('chooseCandidate', { discoveryId, candidateId })],
    }).call.action,
    'resolve',
  );
});
test('decline, cancellation, mismatched plans and multi-source failure stop with actual status', () => {
  const denial = {
    toolName: 'software_install',
    success: false,
    error: { code: 'INSTALL_CANCELLED', message: 'Installation declined.' },
  };
  assert.equal(
    nextSoftwareDecision({ task, evidence: [discover, resolve, denial] }).success,
    false,
  );
  const abort = new AbortController();
  abort.abort();
  assert.equal(nextSoftwareDecision({ task, signal: abort.signal }).success, false);
  assert.equal(
    nextSoftwareDecision({
      task,
      evidence: [
        discover,
        resolve,
        event('install', { status: 'INSTALLED', planId: 'another_plan', verification: verified }),
      ],
    }).success,
    false,
  );
  const failed = nextSoftwareDecision({
    task,
    evidence: [
      event('discoverOnline', {
        discoveryId,
        candidates: [],
        failures: [
          { providerId: 'first', message: 'Offline' },
          { providerId: 'second', message: 'Publisher rejected' },
        ],
      }),
    ],
  });
  assert.match(failed.message, /first: Offline.*second: Publisher rejected/);
});
test('typed capabilities reject invented commands and malformed software queries', () => {
  assert.equal(
    validateCapability('software', 'discover', { query: softwareTask(task).query }),
    null,
  );
  assert.match(
    validateCapability('software', 'install', { planId, command: 'arbitrary.exe' }),
    /Invalid parameter/,
  );
  assert.match(
    validateCapability('software', 'discover', {
      query: { ...softwareTask(task).query, url: 'https://unverified.example' },
    }),
    /Invalid parameter/,
  );
});
test('Astra missing-app recovery invokes the same providers without Winget dependency', async () => {
  clearAstraPlans();
  const plan = {
    app: 'Unknown Future Product',
    steps: [],
    install: true,
    task: 'open Unknown Future Product',
  };
  const decision = await nextAstraDecision({
    key: 'provider-fixture',
    task: plan.task,
    planner: async () => plan,
    evidence: [
      {
        toolName: 'desktop_open',
        success: false,
        error: { code: 'APP_NOT_INSTALLED', message: 'Missing application' },
      },
    ],
  });
  assert.deepEqual(decision.call, {
    tool: 'software',
    action: 'discover',
    params: {
      query: {
        operation: 'install',
        product: plan.app,
        architecture: 'auto',
        scope: 'application',
      },
    },
  });
});
test('orchestrator drives generic installation through independent verification', async () => {
  const actions = [];
  const receipts = {
    discover,
    resolve,
    install: event('install', { status: 'INSTALLED', planId, verification: verified }),
    verify: event('verify', { status: 'INSTALL_VERIFIED', planId, verification: verified }),
  };
  const result = await runOrchestrator({
    task,
    userId: 'software-fixture',
    dependencies: {
      save: () => {},
      createLogger: () => ({ log: () => {} }),
      routeTask: async () => ({ mode: 'agentic', taskType: 'software_management' }),
      executeStep: async (step) => {
        actions.push(step.action);
        return { ...receipts[step.action], toolCallId: step.toolCallId };
      },
    },
  });
  assert.deepEqual(actions, ['discover', 'resolve', 'install', 'verify']);
  assert.equal(result.success, true);
});
test('verifier never equates a discovery-only plan with completed installation', async () => {
  const verdict = await verifyOutcome({
    task,
    steps: [{ tool: 'software', action: 'discover', status: 'done', observation: discover }],
  });
  assert.equal(verdict.success, false);
});
test('batches stage independent products and stop on refusal without claiming unrelated success', () => {
  const batchTask = 'install Future Product and Other Product';
  const install = event('install', { status: 'INSTALLED', planId, verification: verified });
  const verify = event('verify', { status: 'INSTALL_VERIFIED', planId, verification: verified });
  const evidence = [discover, resolve, install, verify];
  const next = nextSoftwareDecision({ task: batchTask, evidence });
  assert.equal(next.call.action, 'discover');
  assert.equal(next.call.params.query.product, 'Other Product');
  assert.equal(next.itemIndex, 1);
  assert.equal(next.completedProducts.length, 1);
  assert.equal(next.success, undefined);
  const secondDiscover = event('discover', {
    ...discover.data,
    discoveryId: 'discovery_second',
    candidates: [{ ...discover.data.candidates[0], candidateId: 'candidate_second' }],
    selectedCandidateId: 'candidate_second',
  });
  const secondResolve = event('resolve', {
    status: 'PLAN_READY',
    plan: { ...resolve.data.plan, planId: 'plan_second12' },
  });
  const denial = {
    toolName: 'software_install',
    success: false,
    error: { code: 'INSTALL_CANCELLED', message: 'Second product declined.' },
  };
  assert.equal(
    nextSoftwareDecision({
      task: batchTask,
      evidence: [...evidence, secondDiscover, secondResolve, denial],
    }).success,
    false,
  );
  const done = nextSoftwareDecision({
    task: batchTask,
    evidence: [
      ...evidence,
      secondDiscover,
      secondResolve,
      event('install', { status: 'INSTALLED', planId: 'plan_second12', verification: verified }),
      event('verify', {
        status: 'INSTALL_VERIFIED',
        planId: 'plan_second12',
        verification: verified,
      }),
    ],
  });
  assert.equal(done.success, true);
  assert.equal(done.completedProducts.length, 2);
});
test('native distribution stages a verified package before a fresh installation approval', () => {
  const nativeResolve = event('resolve', {
    status: 'PLAN_READY',
    plan: { ...resolve.data.plan, protocol: 'download' },
  });
  const staged = event('download', {
    status: 'DOWNLOADED_VERIFIED',
    planId,
    sha256: 'b'.repeat(64),
    verification: { ...verified, criterion: 'package_file' },
    plan: {
      ...resolve.data.plan,
      protocol: 'local-installer',
      privileges: { elevation: 'required' },
    },
  });
  assert.equal(
    nextSoftwareDecision({ task, evidence: [discover, nativeResolve] }).call.action,
    'download',
  );
  const pendingInstall = nextSoftwareDecision({
    task,
    evidence: [discover, nativeResolve, staged],
  });
  assert.equal(pendingInstall.call.action, 'install');
  assert.equal(pendingInstall.success, undefined);
  assert.deepEqual(pendingInstall.call.params, { planId });
  assert.equal(
    nextSoftwareDecision({
      task,
      evidence: [
        discover,
        nativeResolve,
        staged,
        {
          toolName: 'software_install',
          needsConfirmation: true,
          confirmationMessage: 'Approve staged identity and elevation?',
        },
      ],
    }).waiting,
    true,
  );
  const install = event('install', { status: 'INSTALLED', planId, verification: verified });
  assert.equal(
    nextSoftwareDecision({ task, evidence: [discover, nativeResolve, staged, install] }).call
      .action,
    'verify',
  );
  assert.equal(
    nextSoftwareDecision({
      task,
      evidence: [
        discover,
        nativeResolve,
        staged,
        install,
        event('verify', { status: 'INSTALL_VERIFIED', planId, verification: verified }),
      ],
    }).success,
    true,
  );
  assert.equal(
    nextSoftwareDecision({
      task,
      evidence: [discover, nativeResolve, { ...staged, data: { ...staged.data, plan: undefined } }],
    }).success,
    false,
  );
});
test("install batches cannot treat a staged download as the first product's completion", () => {
  const batchTask = 'install Future Product and Other Product';
  const nativeResolve = event('resolve', {
    status: 'PLAN_READY',
    plan: { ...resolve.data.plan, protocol: 'download' },
  });
  const staged = event('download', {
    status: 'DOWNLOADED_VERIFIED',
    planId,
    sha256: 'b'.repeat(64),
    verification: { ...verified, criterion: 'package_file' },
    plan: { ...resolve.data.plan, protocol: 'local-installer' },
  });
  const decision = nextSoftwareDecision({
    task: batchTask,
    evidence: [discover, nativeResolve, staged],
  });
  assert.equal(decision.call.action, 'install');
  assert.equal(decision.itemIndex, 0);
  assert.equal(decision.completedProducts.length, 0);
});
test('unresolved dependencies require their own identity and approval workflow', () => {
  const withDependency = event('resolve', {
    status: 'PLAN_READY',
    plan: {
      ...resolve.data.plan,
      dependencies: [
        { product: 'Required Runtime', resolved: false, requiresSeparateApproval: true },
      ],
    },
  });
  const decision = nextSoftwareDecision({ task, evidence: [discover, withDependency] });
  assert.equal(decision.success, false);
  assert.match(decision.message, /dependencies/);
});
