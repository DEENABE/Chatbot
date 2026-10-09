export interface SoftwareQuery {
  operation: 'install' | 'download' | 'update' | 'reinstall';
  product: string;
  version?: string;
  edition?: string;
  architecture?: 'auto' | 'x64' | 'x86' | 'arm64';
  scope?: 'application' | 'operating-system';
  sourceProviderId?: string;
  publisher?: string;
  language?: string;
}
export interface SoftwareCandidate {
  candidateId?: string;
  providerId: string;
  id: string;
  name: string;
  publisher: string;
  version: string;
  architecture: 'x64' | 'x86' | 'arm64' | 'any';
  trust: 'approved' | 'official' | 'local-selection';
  aliases?: string[];
  query?: SoftwareQuery;
}
export interface InstallerPlan {
  schemaVersion: 1;
  operation: SoftwareQuery['operation'];
  protocol: 'package-manager' | 'local-installer' | 'download' | 'handoff';
  product: { id: string; name: string; publisher: string; version: string; edition?: string };
  source: {
    providerId: string;
    origin: string;
    trust: 'approved' | 'official' | 'local-selection';
    publisher: string;
    allowedHosts: string[];
    publisherTrust: { publishers: string[]; signatureThumbprints?: string[] };
  };
  architecture: 'x64' | 'x86' | 'arm64' | 'any';
  platform: { os: 'windows'; minimumVersion?: string; maximumVersion?: string };
  installer: {
    format: string;
    url?: string;
    path?: string;
    localId?: string;
    sha256?: string;
    size?: number;
    manager?: string;
    source?: string;
    packageId?: string;
  };
  privileges: 'user' | 'administrator' | 'unknown';
  license: { required: boolean | 'unknown'; description?: string };
  reboot: 'none' | 'possible' | 'required' | 'unknown';
  dependencies: Array<{ id?: string; name?: string; version?: string }>;
}
export interface SoftwareSourceProvider {
  id: string;
  capabilities: { offline: boolean; network: boolean };
  descriptor: Record<string, unknown>;
  isAvailable(): Promise<boolean>;
  search(query: SoftwareQuery): Promise<SoftwareCandidate[]>;
  resolve(candidate: SoftwareCandidate): Promise<InstallerPlan>;
}
export function sanitizeSoftwareQuery(value: unknown): SoftwareQuery;
export function validateInstallerPlan(value: unknown): InstallerPlan;
export function planDigest(value: InstallerPlan): string;
