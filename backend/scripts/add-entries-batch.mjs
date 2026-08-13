#!/usr/bin/env node
/**
 * Adds a batch of repair examples to BOTH storage/repair-sessions.json and
 * storage/repair-dataset.jsonl, with duplicate rejection on each file.
 *
 * Unlike the earlier one-off add-*-entries.mjs scripts, this writes the same
 * record shape RepairLogger.logSession() produces (resolved/summary/
 * recommendation/feedback at the top level, canonical domain + subdomain)
 * so validate-storage.mjs passes and the fine-tuning export picks the
 * entries up. Subdomains are normalized through the app's own function, so
 * an unknown label becomes null instead of silently-dropped noise.
 *
 * Usage: node scripts/add-entries-batch.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { addEntries, checkDuplicates } from './dataset-manager.mjs';
import { normalizeSubdomain } from '../src/knowledge/subdomains.js';
import { classifyCommand } from '../src/agent/dangerClassifier.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS = path.join(root, 'storage', 'repair-sessions.json');
const DATASET = path.join(root, 'storage', 'repair-dataset.jsonl');
const dryRun = process.argv.includes('--dry-run');

/** @type {Array<{domain:string,subdomain:string,goal:string,plan:string[],steps:Array,summary:string,recommendation:string}>} */
const ENTRIES = [
  {
    domain: 'network',
    subdomain: 'wifi',
    goal: 'Wi-Fi drops every few minutes but reconnects on its own',
    plan: ['Check the adapter power-saving setting', 'Review recent disconnect events', 'Disable power management on the adapter'],
    steps: [
      { command: "Get-NetAdapter -Name 'Wi-Fi' | Select-Object Name, Status, LinkSpeed", exitCode: 0, stdout: 'Wi-Fi Up 585 Mbps' },
      { command: "Get-WinEvent -LogName System -MaxEvents 40 | Where-Object Id -in 4201,4202 | Select-Object TimeCreated, Id", exitCode: 0, stdout: 'Repeated 4202 disconnect events every ~4 minutes' },
      { command: "Get-NetAdapterPowerManagement -Name 'Wi-Fi' | Select-Object AllowComputerToTurnOffDevice", exitCode: 0, stdout: 'AllowComputerToTurnOffDevice : Enabled' },
      { command: "Set-NetAdapterPowerManagement -Name 'Wi-Fi' -AllowComputerToTurnOffDevice Disabled", exitCode: 0, stdout: '' },
    ],
    summary: 'Windows was powering down the wireless adapter to save energy, which dropped the link every few minutes. Disabling that power-management setting kept the connection stable.',
    recommendation: 'If it recurs on battery, also set the Wireless Adapter power-saving mode to Maximum Performance in the active power plan.',
  },
  {
    domain: 'performance',
    subdomain: 'memory',
    goal: 'Memory usage climbs to 90% overnight even with no apps open',
    plan: ['Identify the top memory consumers', 'Check for a leaking non-paged pool', 'Restart the offending service'],
    steps: [
      { command: 'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 Name, @{n="MB";e={[int]($_.WorkingSet64/1MB)}}', exitCode: 0, stdout: 'NonPagedPool-heavy: svchost 2100 MB' },
      { command: 'Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory, TotalVisibleMemorySize', exitCode: 0, stdout: 'FreePhysicalMemory : 812340' },
      { command: "Get-Service -Name 'SysMain' | Select-Object Name, Status, StartType", exitCode: 0, stdout: 'SysMain Running Automatic' },
      { command: "Restart-Service -Name 'SysMain'", exitCode: 0, stdout: '' },
    ],
    summary: 'The SysMain (Superfetch) service was accumulating a large working set overnight. Restarting it released the memory and usage returned to a normal idle baseline.',
    recommendation: 'On systems with an SSD, SysMain gives little benefit — consider setting it to Manual if the growth returns.',
  },
  {
    domain: 'file',
    subdomain: 'permissions',
    goal: 'Access denied when saving to a folder I own',
    plan: ['Confirm the current owner', 'Inspect the effective ACL', 'Restore inherited permissions'],
    steps: [
      { command: "Get-Acl 'C:\\Projects\\reports' | Select-Object Owner", exitCode: 0, stdout: 'Owner : BUILTIN\\Administrators' },
      { command: "(Get-Acl 'C:\\Projects\\reports').Access | Select-Object IdentityReference, FileSystemRights", exitCode: 0, stdout: 'No entry for the current user' },
      { command: "icacls 'C:\\Projects\\reports' /grant \"$env:USERNAME:(OI)(CI)M\"", exitCode: 0, stdout: 'Successfully processed 1 files' },
      { command: "(Get-Acl 'C:\\Projects\\reports').Access | Where-Object IdentityReference -like \"*$env:USERNAME*\"", exitCode: 0, stdout: 'Modify granted' },
    ],
    summary: 'The folder had been created by an elevated process, leaving Administrators as owner with no ACL entry for the interactive user. Granting Modify rights restored normal write access.',
    recommendation: 'Avoid creating project folders from an elevated shell; if you must, run takeown afterwards to reset ownership.',
  },
  {
    domain: 'security',
    subdomain: 'defender',
    goal: 'Defender real-time protection keeps switching itself off',
    plan: ['Check whether a policy is forcing it off', 'Look for a competing antivirus', 'Re-enable real-time monitoring'],
    steps: [
      { command: 'Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled, AntivirusEnabled', exitCode: 0, stdout: 'RealTimeProtectionEnabled : False' },
      { command: 'Get-MpPreference | Select-Object DisableRealtimeMonitoring', exitCode: 0, stdout: 'DisableRealtimeMonitoring : True' },
      { command: 'Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object displayName', exitCode: 0, stdout: 'Windows Defender' },
      { command: 'Set-MpPreference -DisableRealtimeMonitoring $false', exitCode: 0, stdout: '' },
    ],
    summary: 'A leftover DisableRealtimeMonitoring preference — not a third-party antivirus — was keeping real-time protection off. Clearing that preference re-enabled it.',
    recommendation: 'If the setting reverts after a reboot, check Group Policy under Computer Configuration > Administrative Templates > Windows Defender Antivirus.',
  },
  {
    domain: 'bluetooth',
    subdomain: 'audio-profile',
    goal: 'Bluetooth headphones sound muffled during video calls',
    plan: ['Identify which profile is active', 'Check the enabled audio endpoints', 'Force the stereo endpoint as default'],
    steps: [
      { command: "Get-PnpDevice -Class AudioEndpoint | Select-Object Status, FriendlyName", exitCode: 0, stdout: 'OK Headset (Hands-Free AG Audio)\nOK Headphones (Stereo)' },
      { command: "Get-PnpDevice | Where-Object FriendlyName -like '*Hands-Free*' | Select-Object Status, FriendlyName", exitCode: 0, stdout: 'OK Headset Hands-Free AG Audio' },
      { command: 'Get-Service BthAvctpSvc | Select-Object Name, Status', exitCode: 0, stdout: 'BthAvctpSvc Running' },
    ],
    summary: 'The call app had switched the headphones to the Hands-Free (HFP) profile to use the microphone, which drops audio to narrowband quality. This is a Bluetooth profile limitation, not a fault.',
    recommendation: 'Select the Stereo (A2DP) endpoint for playback and use a separate microphone, or accept HFP quality while the mic is live.',
  },
  {
    domain: 'windows',
    subdomain: 'update',
    goal: 'Windows Update fails repeatedly with error 0x80070020',
    plan: ['Read the error code meaning', 'Stop the update services', 'Clear the download cache and retry'],
    steps: [
      { command: 'Get-WindowsUpdateLog -LogPath "$env:TEMP\\wu.log"', exitCode: 0, stdout: 'Log converted' },
      { command: "Get-Service wuauserv, bits, cryptsvc | Select-Object Name, Status", exitCode: 0, stdout: 'wuauserv Running\nbits Running\ncryptsvc Running' },
      { command: 'Stop-Service wuauserv, bits -Force', exitCode: 0, stdout: '' },
      { command: "Rename-Item 'C:\\Windows\\SoftwareDistribution' 'SoftwareDistribution.old' -ErrorAction SilentlyContinue", exitCode: 0, stdout: '' },
      { command: 'Start-Service wuauserv, bits', exitCode: 0, stdout: '' },
    ],
    summary: '0x80070020 means a file in the update cache was locked by another process. Stopping the update services, renaming SoftwareDistribution so a clean cache is rebuilt, and restarting the services let the update install.',
    recommendation: 'Delete SoftwareDistribution.old once the update completes successfully to reclaim the disk space.',
  },
];

// Reject anything the agent loop would refuse to run, so this script can't
// reintroduce the poisoned training examples the export filter now strips.
const rejected = [];
for (const entry of ENTRIES) {
  for (const step of entry.steps) {
    if (classifyCommand(step.command).level === 'blocked') {
      rejected.push(`${entry.goal} -> ${step.command}`);
    }
  }
}
if (rejected.length) {
  console.error('Refusing to add entries containing blocked-level commands:');
  rejected.forEach((r) => console.error('  - ' + r));
  process.exit(1);
}

const now = new Date().toISOString();

const sessionRecords = ENTRIES.map((e) => ({
  id: crypto.randomUUID(),
  createdAt: now,
  goal: e.goal,
  domain: e.domain,
  subdomain: normalizeSubdomain(e.domain, e.subdomain),
  plan: e.plan,
  steps: e.steps.map((s) => ({
    command: s.command,
    blocked: false,
    exitCode: s.exitCode ?? 0,
    stdout: (s.stdout || '').slice(0, 1500),
    stderr: (s.stderr || '').slice(0, 800),
    reason: null,
  })),
  resolved: true,
  summary: e.summary,
  recommendation: e.recommendation,
  feedback: null,
}));

const datasetRecords = ENTRIES.map((e) => {
  const label = normalizeSubdomain(e.domain, e.subdomain)
    ? `${e.domain} (${normalizeSubdomain(e.domain, e.subdomain)})`
    : e.domain;
  const commands = e.steps.map((s) => `- ${s.command}`).join('\n');
  return {
    messages: [
      { role: 'system', content: `You are a Windows repair expert specializing in ${label} problems. Diagnose with read-only commands first, then apply safe fixes.` },
      { role: 'user', content: e.goal },
      { role: 'assistant', content: `${e.summary}\nCommands used:\n${commands}\nRecommendation: ${e.recommendation}` },
    ],
  };
});

if (dryRun) {
  console.log(`--dry-run: would add ${sessionRecords.length} sessions and ${datasetRecords.length} dataset lines.`);
  process.exit(0);
}

const resSessions = addEntries(SESSIONS, sessionRecords, { key: 'goal' });
console.log(`repair-sessions.json  added ${resSessions.addedCount}, skipped ${resSessions.skippedCount} (duplicate goal), total ${resSessions.totalNow}`);

const resDataset = addEntries(DATASET, datasetRecords, { key: 'messages.1.content' });
console.log(`repair-dataset.jsonl  added ${resDataset.addedCount}, skipped ${resDataset.skippedCount} (duplicate question), total ${resDataset.totalNow}`);

const dupSessions = checkDuplicates(SESSIONS, { key: 'goal' });
const dupDataset = checkDuplicates(DATASET, { key: 'messages.1.content' });
console.log(`\nPost-write duplicate check: sessions=${dupSessions.duplicateCount}, dataset=${dupDataset.duplicateCount}`);
