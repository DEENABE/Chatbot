/**
 * @fileoverview Network Service for network diagnostics and information.
 * Provides ping, traceroute, DNS lookup, port scanning, netstat, IP config,
 * and a basic speed / reachability test.  All actions are non-destructive.
 * Hosts and IPs are validated to prevent command injection.
 *
 * @module NetworkService
 */

import { execFile } from 'child_process';
import dns from 'dns';
import net from 'net';
import http from 'http';
import https from 'https';
import { BaseToolService } from '../BaseToolService.js';

/** Pattern used to detect injection-prone characters in user-supplied hosts. */
const INJECTION_PATTERN = /[;&|`$()'\n\r]/;

/**
 * Validate that a host string is a plausible hostname or IP and is free of
 * shell meta-characters.
 *
 * @param {string} host - The host/IP to validate.
 * @throws {Error} If the host is invalid or contains dangerous characters.
 */
function validateHost(host) {
  if (!host || typeof host !== 'string') {
    throw new Error('host must be a non-empty string');
  }

  if (INJECTION_PATTERN.test(host)) {
    throw new Error(
      'host contains invalid characters that could be used for command injection',
    );
  }

  // Loose pattern: hostname, IPv4, or bracketed/un-bracketed IPv6
  const hostnameRe = /^[a-zA-Z0-9.:%[\]_-]+$/;
  if (!hostnameRe.test(host)) {
    throw new Error('host does not appear to be a valid hostname or IP address');
  }
}

/**
 * Network diagnostics service. All actions are read-only.
 *
 * @extends BaseToolService
 */
export class NetworkService extends BaseToolService {
  constructor(confirmationGate) {
    super('network', confirmationGate);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** @override */
  get actions() {
    return {
      ping: {
        handler: this.ping.bind(this),
        schema: {
          host: { type: 'string', required: true },
          count: { type: 'number', required: false, min: 1, max: 20 },
          timeout: { type: 'number', required: false },
        },
        destructive: false,
        description: 'Ping a host and report round-trip statistics',
      },
      traceroute: {
        handler: this.traceroute.bind(this),
        schema: {
          host: { type: 'string', required: true },
          maxHops: { type: 'number', required: false },
        },
        destructive: false,
        description: 'Trace the route to a host',
      },
      dnsLookup: {
        handler: this.dnsLookup.bind(this),
        schema: {
          hostname: { type: 'string', required: true },
          type: {
            type: 'enum',
            required: false,
            values: ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME'],
          },
        },
        destructive: false,
        description: 'Perform a DNS lookup for the given hostname and record type',
      },
      portScan: {
        handler: this.portScan.bind(this),
        schema: {
          host: { type: 'string', required: true },
          ports: { type: 'array', required: true, minItems: 1, maxItems: 100 },
        },
        destructive: false,
        description: 'Check whether specific TCP ports are open on a host',
      },
      netstat: {
        handler: this.netstat.bind(this),
        schema: {
          state: {
            type: 'enum',
            required: false,
            values: ['ESTABLISHED', 'LISTENING', 'TIME_WAIT', 'CLOSE_WAIT', 'ALL'],
          },
          port: { type: 'number', required: false },
        },
        destructive: false,
        description: 'List current TCP connections with optional filtering',
      },
      ipConfig: {
        handler: this.ipConfig.bind(this),
        schema: {},
        destructive: false,
        description: 'Retrieve full IP configuration for all adapters',
      },
      speedTest: {
        handler: this.speedTest.bind(this),
        schema: {
          url: { type: 'string', required: false },
        },
        destructive: false,
        description: 'Perform a basic HTTP reachability and response-time test',
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Execute a command and return stdout.
   *
   * @param {string} cmd - Executable name.
   * @param {string[]} args - Arguments.
   * @returns {Promise<string>}
   */
  _exec(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { windowsHide: true, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${cmd} failed: ${stderr?.trim() || err.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /**
   * Execute a PowerShell command and return parsed JSON.
   *
   * @param {string} command - PowerShell command.
   * @returns {Promise<*>}
   */
  _runPS(command) {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`PowerShell error: ${stderr?.trim() || err.message}`));
            return;
          }
          try {
            const trimmed = stdout.trim();
            if (!trimmed) { resolve(null); return; }
            resolve(JSON.parse(trimmed));
          } catch {
            resolve(stdout.trim());
          }
        },
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  /**
   * Ping a host.
   *
   * @param {{ host: string, count?: number, timeout?: number }} params
   * @returns {Promise<Object>}
   */
  async ping(params) {
    const { host, count = 4, timeout = 1000 } = params;
    validateHost(host);

    const safeCount = Math.max(1, Math.min(Number(count) || 4, 20));
    const safeTimeout = Math.max(100, Number(timeout) || 1000);

    const stdout = await this._exec('ping', [
      '-n', String(safeCount),
      '-w', String(safeTimeout),
      host,
    ]);

    return this._parsePingOutput(stdout, host);
  }

  /**
   * Trace the route to a host.
   *
   * @param {{ host: string, maxHops?: number }} params
   * @returns {Promise<{ host: string, hops: Array }>}
   */
  async traceroute(params) {
    const { host, maxHops = 30 } = params;
    validateHost(host);

    const safeHops = Math.max(1, Math.min(Number(maxHops) || 30, 64));

    const stdout = await this._exec('tracert', [
      '-d',
      '-h', String(safeHops),
      host,
    ]);

    return { host, hops: this._parseTracertOutput(stdout) };
  }

  /**
   * Perform a DNS lookup.
   *
   * @param {{ hostname: string, type?: string }} params
   * @returns {Promise<{ hostname: string, type: string, records: Array }>}
   */
  async dnsLookup(params) {
    const { hostname, type = 'A' } = params;
    validateHost(hostname);

    const recordType = (type || 'A').toUpperCase();
    const records = await dns.promises.resolve(hostname, recordType);

    return { hostname, type: recordType, records };
  }

  /**
   * Scan specific TCP ports on a host.
   *
   * @param {{ host: string, ports: number[] }} params
   * @returns {Promise<{ host: string, results: Array<{ port: number, open: boolean }> }>}
   */
  async portScan(params) {
    const { host, ports } = params;
    validateHost(host);

    if (!Array.isArray(ports) || ports.length === 0) {
      throw new Error('ports must be a non-empty array');
    }
    if (ports.length > 100) {
      throw new Error('ports array must not exceed 100 entries');
    }

    const CONCURRENCY = 20;
    const TIMEOUT_MS = 2000;
    const results = [];

    // Process in batches of CONCURRENCY
    for (let i = 0; i < ports.length; i += CONCURRENCY) {
      const batch = ports.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((port) => this._checkPort(host, Number(port), TIMEOUT_MS)),
      );
      for (let j = 0; j < settled.length; j++) {
        const port = Number(batch[j]);
        results.push({
          port,
          open: settled[j].status === 'fulfilled' && settled[j].value === true,
        });
      }
    }

    return { host, results };
  }

  /**
   * List current TCP connections.
   *
   * @param {{ state?: string, port?: number }} params
   * @returns {Promise<{ connections: Array }>}
   */
  async netstat(params = {}) {
    const { state, port } = params;

    const raw = await this._runPS(
      'Get-NetTCPConnection | Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess | ConvertTo-Json',
    );

    let connections = raw == null ? [] : Array.isArray(raw) ? raw : [raw];

    // Filter by state
    if (state && state !== 'ALL') {
      const upper = state.toUpperCase();
      connections = connections.filter(
        (c) => (c.State || '').toString().toUpperCase().includes(upper),
      );
    }

    // Filter by port
    if (port != null) {
      const p = Number(port);
      connections = connections.filter(
        (c) => c.LocalPort === p || c.RemotePort === p,
      );
    }

    return { connections };
  }

  /**
   * Retrieve full IP configuration.
   *
   * @returns {Promise<{ adapters: Array }>}
   */
  async ipConfig() {
    const stdout = await this._exec('ipconfig', ['/all']);
    return { adapters: this._parseIpconfigOutput(stdout) };
  }

  /**
   * Basic HTTP reachability and response-time test.
   *
   * @param {{ url?: string }} params
   * @returns {Promise<{ url: string, reachable: boolean, statusCode?: number, responseTimeMs?: number }>}
   */
  async speedTest(params = {}) {
    const { url = 'http://www.google.com' } = params;

    // Validate URL scheme
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('URL must use http or https protocol');
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const start = Date.now();

    return new Promise((resolve) => {
      const req = lib.get(url, { timeout: 10000 }, (res) => {
        // Consume the response body to avoid memory leaks
        res.resume();
        res.on('end', () => {
          resolve({
            url,
            reachable: true,
            statusCode: res.statusCode,
            responseTimeMs: Date.now() - start,
          });
        });
      });

      req.on('error', () => {
        resolve({
          url,
          reachable: false,
          statusCode: null,
          responseTimeMs: Date.now() - start,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          url,
          reachable: false,
          statusCode: null,
          responseTimeMs: Date.now() - start,
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Output parsers
  // ---------------------------------------------------------------------------

  /**
   * Parse Windows `ping` output.
   *
   * @param {string} stdout - Raw ping output.
   * @param {string} host   - Original host.
   * @returns {Object}
   */
  _parsePingOutput(stdout, host) {
    const result = {
      host,
      sent: 0,
      received: 0,
      lost: 0,
      lossPercent: 0,
      roundTrip: { min: null, max: null, avg: null },
    };

    // Packets: Sent = 4, Received = 4, Lost = 0 (0% loss)
    const packetMatch = stdout.match(
      /Sent\s*=\s*(\d+).*Received\s*=\s*(\d+).*Lost\s*=\s*(\d+)\s*\((\d+)%/i,
    );
    if (packetMatch) {
      result.sent = parseInt(packetMatch[1], 10);
      result.received = parseInt(packetMatch[2], 10);
      result.lost = parseInt(packetMatch[3], 10);
      result.lossPercent = parseInt(packetMatch[4], 10);
    }

    // Minimum = 1ms, Maximum = 3ms, Average = 2ms
    const rtMatch = stdout.match(
      /Minimum\s*=\s*(\d+)ms.*Maximum\s*=\s*(\d+)ms.*Average\s*=\s*(\d+)ms/i,
    );
    if (rtMatch) {
      result.roundTrip.min = parseInt(rtMatch[1], 10);
      result.roundTrip.max = parseInt(rtMatch[2], 10);
      result.roundTrip.avg = parseInt(rtMatch[3], 10);
    }

    return result;
  }

  /**
   * Parse Windows `tracert` output into an array of hops.
   *
   * @param {string} stdout - Raw tracert output.
   * @returns {Array<{ hop: number, ip: string|null, rtt: (number|null)[] }>}
   */
  _parseTracertOutput(stdout) {
    const hops = [];
    const lines = stdout.split('\n');

    for (const line of lines) {
      // Typical: "  3    <1 ms    <1 ms    <1 ms  10.0.0.1"
      const match = line.match(
        /^\s*(\d+)\s+([\d<*]+\s*ms|[*])\s+([\d<*]+\s*ms|[*])\s+([\d<*]+\s*ms|[*])\s+(.+)$/,
      );
      if (match) {
        const parseRtt = (s) => {
          const t = s.trim();
          if (t === '*') return null;
          const num = parseInt(t.replace('<', ''), 10);
          return isNaN(num) ? null : num;
        };

        hops.push({
          hop: parseInt(match[1], 10),
          ip: match[5].trim() || null,
          rtt: [parseRtt(match[2]), parseRtt(match[3]), parseRtt(match[4])],
        });
      }
    }

    return hops;
  }

  /**
   * Parse `ipconfig /all` output into structured adapter data.
   *
   * @param {string} stdout - Raw ipconfig output.
   * @returns {Array<Object>}
   */
  _parseIpconfigOutput(stdout) {
    const adapters = [];
    // Split on adapter headers
    const sections = stdout.split(/\r?\n(?=\S.*adapter\s)/i);

    for (const section of sections) {
      const headerMatch = section.match(/^(.+adapter\s+.+):/im);
      if (!headerMatch) continue;

      const adapter = { name: headerMatch[1].trim() };
      const lines = section.split('\n').slice(1);

      for (const line of lines) {
        const kv = line.match(/^\s{3,}(.+?)\s*[.:]\s*(.+)$/);
        if (kv) {
          const key = kv[1].trim().replace(/[\s.]+/g, '_').toLowerCase();
          const value = kv[2].trim();
          // Collect multi-value fields into arrays
          if (adapter[key] !== undefined) {
            if (!Array.isArray(adapter[key])) {
              adapter[key] = [adapter[key]];
            }
            adapter[key].push(value);
          } else {
            adapter[key] = value;
          }
        }
      }

      adapters.push(adapter);
    }

    return adapters;
  }

  /**
   * Attempt a TCP connection to a single port.
   *
   * @param {string} host - Target host.
   * @param {number} port - Target port number.
   * @param {number} timeout - Connection timeout in ms.
   * @returns {Promise<boolean>} Resolves true if port is open.
   */
  _checkPort(host, port, timeout) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });

      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeout);

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });

      socket.once('error', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      });
    });
  }
}

export default NetworkService;

