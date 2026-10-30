// Renderer-safe admission. Product identity remains a query until a trusted provider resolves it.
const QUESTION =
  /^(?:how|what|why|when|where|which|who|explain|describe|tell me|is|are|does|do i|should|can i)\b/i;
const IMPERATIVE =
  /^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(install|download|update|upgrade|reinstall)\s+([\s\S]+)$/i;
const DESKTOP_CONTINUATION =
  /\b(?:and(?: then)?|then)\s+(?:open|launch|start|type|write|enter|paste|save|play|draw|create|click)\b/i;
const LOCAL_SOURCE =
  /\b(?:from|using)\s+(?:an?\s+|the\s+)?(?:approved\s+)?(?:local|offline)\s+(?:folder|file|installer|cache)\b|[A-Za-z]:[\\/]/i;
const NO_PRODUCT =
  /^(?:(?:a|an|the|some|several|multiple|all)\s+)?(?:apps?|applications?|software|programs?|installers?|operating\s+systems?)(?:\s+installer)?$/i;
const ARCHITECTURES = {
  x64: 'x64',
  amd64: 'x64',
  '64-bit': 'x64',
  '64 bit': 'x64',
  x86: 'x86',
  '32-bit': 'x86',
  '32 bit': 'x86',
  arm64: 'arm64',
  aarch64: 'arm64',
};

export function validSoftwareQuery(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const allowed = new Set([
    'operation',
    'product',
    'version',
    'edition',
    'architecture',
    'scope',
    'sourceProviderId',
    'publisher',
    'language',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (
    !['install', 'download', 'update', 'reinstall'].includes(value.operation) ||
    !['application', 'operating-system'].includes(value.scope) ||
    !['auto', 'x64', 'x86', 'arm64'].includes(value.architecture)
  )
    return false;
  if (
    value.sourceProviderId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value.sourceProviderId)
  )
    return false;
  for (const [key, field] of Object.entries(value)) {
    const limit =
      key === 'version'
        ? 80
        : ['product', 'publisher', 'edition', 'language'].includes(key)
          ? 180
          : 128;
    if (
      typeof field !== 'string' ||
      !field.trim() ||
      field.length > limit ||
      /[\x00-\x1f\x7f]/.test(field)
    )
      return false;
  }
  return (
    typeof value.product === 'string' &&
    !/https?:|[\\/]/i.test(value.product) &&
    !/^(?:powershell(?:\.exe)?\s+-|cmd(?:\.exe)?\s+\/c\b|(?:iex|invoke-expression)\s+|curl\s+https?:)/i.test(
      value.product,
    )
  );
}

/** Returns null for explanatory questions and compound desktop tasks owned by Astra. */
export function softwareTask(message) {
  const task = String(message || '').trim();
  if (!task || task.length > 4000 || QUESTION.test(task)) return null;
  const hit = task.match(IMPERATIVE);
  if (!hit) return null;
  const continuation = DESKTOP_CONTINUATION.exec(hit[2]);
  if (
    hit[1].toLowerCase() === 'install' &&
    continuation &&
    !/\b(?:and|or)\b|[,;\n]/i.test(hit[2].slice(0, continuation.index)) &&
    !/\b(?:and(?: then)?|then)\s+(?:install|download|update|reinstall)\b/i.test(hit[2])
  )
    return null;
  let operation = hit[1].toLowerCase();
  if (operation === 'upgrade') operation = 'update';
  let product = hit[2]
    .replace(/[.!?]+$/, '')
    .replace(/\s+please$/i, '')
    .trim();
  const scope =
    /\b(?:operating\s+system|os\s+(?:installer|image)|boot\s+media|clean\s+install|disk\s+format|format\s+(?:the\s+)?disk)\b/i.test(
      product,
    )
      ? 'operating-system'
      : 'application';
  const base = { task, query: { operation, product, architecture: 'auto', scope } };
  if (/\b(?:crack|keygen|activation\s+bypass|pirated|unauthorized\s+kms)\b/i.test(product))
    return {
      ...base,
      blocked: true,
      message:
        'Use a legitimate publisher distribution and your own license or administrator entitlement.',
    };
  if (/https?:\/\//i.test(product))
    return {
      ...base,
      needsClarification: true,
      message:
        'Select a registered, approved software source. A supplied website address is not verified installation authority.',
    };
  if (LOCAL_SOURCE.test(product))
    return {
      ...base,
      needsLocalSelection: true,
      needsClarification: true,
      message:
        'Choose an approved local installer through the offline installer picker and enter its product name. Files are verified before installation approval.',
    };
  if (
    /\bor\b|;|\b(?:and(?: then)?|then)\s+(?:open|launch|type|write|save|play|click|delete|remove|format|run|execute)\b/i.test(
      product,
    )
  )
    return {
      ...base,
      needsClarification: true,
      message: 'Specify the exact software products separately from desktop or system actions.',
    };
  const products = product
    .split(
      /\s*,\s*(?:and\s+)?|\s+and(?:\s+then)?\s+(?!(?:edition|version|publisher|architecture)\b)|\s*\n\s*/i,
    )
    .filter(Boolean);
  if (products.length > 1) {
    if (products.length > 8)
      return {
        ...base,
        needsClarification: true,
        message:
          'Request at most eight products in one batch. Each product needs its own identity review and installation approval.',
      };
    const items = products.map((item) =>
      softwareTask(
        /^(?:install|download|update|upgrade|reinstall)\s+/i.test(item)
          ? item
          : `${operation} ${item}`,
      ),
    );
    const unresolved = items.find(
      (item) => !item || item.blocked || item.needsClarification || item.highRisk,
    );
    if (unresolved !== undefined || items.some((item) => !item))
      return {
        ...base,
        needsClarification: true,
        message:
          unresolved?.message ||
          'Clarify each product in the batch before any installation is prepared.',
      };
    return { task, query: items[0].query, queries: items.map((item) => item.query) };
  }
  let sourceProviderId;
  product = product.replace(
    /\s+from\s+(?:the\s+)?(?:registered\s+|approved\s+)?provider\s+([A-Za-z0-9][A-Za-z0-9._:-]{0,95})\s*$/i,
    (_, found) => {
      sourceProviderId = found;
      return '';
    },
  );
  let publisher;
  product = product.replace(
    /\s+(?:published\s+)?by\s+([\p{L}\p{N} &'’()._-]{1,180})\s*$/iu,
    (_, found) => {
      publisher = found.trim();
      return '';
    },
  );
  let version;
  product = product.replace(
    /^(?:the\s+)?(?:specified\s+|older\s+)?(?:version|release)\s+([0-9][\w.+-]*)\s+of\s+/i,
    (_, found) => {
      version = found;
      return '';
    },
  );
  product = product.replace(
    /\b(?:(?:specified\s+)?older\s+)?(?:version|release|v)\s*([0-9][\w.+-]*)\b/i,
    (_, found) => {
      version = found;
      return ' ';
    },
  );
  // A trailing numeric version is preserved as a requirement, never used as an executable argument.
  product = product.replace(/\s+(\d+\.\d+(?:\.[\w.+-]+)*)$/, (_, found) => {
    version ||= found;
    return '';
  });
  let architecture = 'auto';
  product = product.replace(
    /\b(?:for\s+)?(x64|amd64|x86|arm64|aarch64|64[- ]bit|32[- ]bit)\b/i,
    (_, found) => {
      architecture = ARCHITECTURES[found.toLowerCase()];
      return ' ';
    },
  );
  let edition;
  product = product.replace(
    /\b(?:edition\s+["']?([\p{L}\p{N} ._-]{1,40})["']?|([\p{L}\p{N}_-]+)\s+edition)\s*$/iu,
    (_, first, second) => {
      edition = (first || second).trim();
      return ' ';
    },
  );
  product = product
    .replace(/^(?:(?:the|my)\s+)?(?:latest(?:\s+compatible)?\s+(?:version\s+of\s+)?|an?\s+)?/i, '')
    .replace(/\s+(?:the\s+)?latest(?:\s+compatible)?\s+version\s*$/i, '')
    .replace(/^(?:operating\s+system|os\s+installer)\s+/i, '')
    .replace(/\s+operating\s+system(?=\s+installer\s*$|\s*$)/i, '')
    .replace(/\s+(?:installer|application|app)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2');
  const query = {
    operation,
    product,
    architecture,
    scope,
    ...(version ? { version } : {}),
    ...(edition ? { edition } : {}),
    ...(sourceProviderId ? { sourceProviderId } : {}),
    ...(publisher ? { publisher } : {}),
  };
  if (!product || NO_PRODUCT.test(product) || !validSoftwareQuery(query))
    return {
      ...base,
      needsClarification: true,
      message: 'Name the product you want, including the requested version or edition if needed.',
    };
  if (scope === 'operating-system' && operation !== 'download')
    return {
      task,
      query,
      highRisk: true,
      message:
        'Operating-system installation, upgrades, disk changes, and boot-media creation require a separate high-risk workflow. You can request an installer download for review.',
    };
  return { task, query };
}
