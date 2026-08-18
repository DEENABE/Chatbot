import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';
import { config } from '../config.js';

let dbInstance = null;

// Case-insensitive column lookup: stored rows keep camelCase keys (userId,
// chatId, folderId) but the SQL parser lowercases column names. Resolve the
// value by matching keys case-insensitively so WHERE clauses actually match.
function ciGet(row, colLower) {
  if (row[colLower] !== undefined) return row[colLower];
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === colLower) return row[key];
  }
  return undefined;
}

// Split a VALUES(...) body on top-level commas (good enough for the simple
// literal/placeholder tuples this shim receives).
function splitValueTokens(body) {
  return body.split(',').map((token) => token.trim());
}

class JSONDatabase {
  constructor(filePath) {
    this.filePath = filePath.replace(/\.db$/, '_db.json').replace(/db\.sqlite$/, 'db_store.json');
    this.state = {
      chunks: [],
      chunks_vec: {},
      usage_log: [],
      users: [],
      sessions: [],
      folders: [],
      chats: [],
      messages: [],
      memories: [],
      documents: []
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        this.state = JSON.parse(content);
      }
      
      // Ensure all tables exist
      const keys = ['chunks', 'chunks_vec', 'usage_log', 'users', 'sessions', 'folders', 'chats', 'messages', 'memories', 'documents'];
      for (const key of keys) {
        if (key === 'chunks_vec') {
          if (!this.state[key] || typeof this.state[key] !== 'object') this.state[key] = {};
        } else {
          if (!Array.isArray(this.state[key])) this.state[key] = [];
        }
      }

      // Auto-seed default developer user
      if (this.state.users.length === 0) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync('admin', salt, 64).toString('hex');
        this.state.users.push({
          id: crypto.randomUUID(),
          username: 'admin',
          displayName: 'Chanakya Developer',
          email: null,
          department: null,
          role: 'Employee',
          permissions: JSON.stringify(['read', 'write']),
          passwordHash: hash,
          salt,
          createdAt: new Date().toISOString()
        });
        this.save();
      }
    } catch (err) {
      console.error('Failed to load JSON database, starting fresh:', err);
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save JSON database:', err);
    }
  }

  exec(sql) {
    // No-op (replaces sqlite schema execution)
  }

  pragma(sql) {
    // No-op (replaces sqlite pragma execution)
  }

  // better-sqlite3 compatibility: return a function that runs the body.
  // (No real atomicity — this JSON store is single-threaded and synchronous.)
  transaction(fn) {
    return (...args) => fn(...args);
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    // Determine the table name
    let table = null;
    let tableMatch = normalized.match(/(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+([a-zA-Z0-9_]+)/i);
    if (tableMatch) {
      table = tableMatch[1].toLowerCase();
    }

    // Handlers for specific complex queries
    
    // Vector search query
    if (normalized.includes('FROM chunks_vec') || normalized.includes('embedding MATCH ?')) {
      return {
        all: (...params) => {
          const queryEmbedding = JSON.parse(params[0]);
          const k = params[1];
          const sourceFilter = params[2]; // optional source filter

          let results = [];
          for (const chunk of this.state.chunks) {
            if (sourceFilter && chunk.source !== sourceFilter) continue;
            const embedding = this.state.chunks_vec[chunk.id];
            if (!embedding || !Array.isArray(embedding)) continue;

            let distance = 0;
            const len = Math.min(queryEmbedding.length, embedding.length);
            for (let i = 0; i < len; i++) {
              const diff = queryEmbedding[i] - embedding[i];
              distance += diff * diff;
            }

            results.push({
              id: chunk.id,
              text: chunk.text,
              source: chunk.source,
              metadata: typeof chunk.metadata === 'string' ? chunk.metadata : JSON.stringify(chunk.metadata || {}),
              distance: distance
            });
          }

          results.sort((a, b) => a.distance - b.distance);
          return results.slice(0, k);
        }
      };
    }

    // Default Statement object builder
    const stmt = {
      run: (...params) => {
        if (!table || !this.state[table]) this.state[table] = [];

        if (normalized.startsWith('INSERT')) {
          // Parse columns e.g. INSERT INTO users (id, username) VALUES (@id, @username)
          // Uses INTO (not INSERT INTO) so INSERT OR REPLACE INTO also matches.
          let colsMatch = normalized.match(/INTO\s+\w+\s*\(([^)]+)\)/i);
          let cols = colsMatch ? colsMatch[1].split(',').map(s => s.trim()) : [];
          
          let row = {};
          if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null) {
            // Named parameters
            const obj = params[0];
            for (const col of cols) {
              row[col] = obj[col] !== undefined ? obj[col] : (obj['@' + col] !== undefined ? obj['@' + col] : obj[':' + col]);
            }
          } else {
            // Positional parameters — honour literal values in the VALUES
            // clause (e.g. NULL, 0) so placeholders don't shift into the
            // wrong columns.
            const valuesMatch = normalized.match(/VALUES\s*\(([^)]*)\)/i);
            const tokens = valuesMatch ? splitValueTokens(valuesMatch[1]) : [];
            let paramIdx = 0;
            for (let i = 0; i < cols.length; i++) {
              const tok = tokens[i];
              if (tok === undefined || tok === '?') {
                row[cols[i]] = params[paramIdx++];
              } else if (/^null$/i.test(tok)) {
                row[cols[i]] = null;
              } else if (/^-?\d+(\.\d+)?$/.test(tok)) {
                row[cols[i]] = Number(tok);
              } else if (/^'.*'$/.test(tok)) {
                row[cols[i]] = tok.slice(1, -1);
              } else {
                row[cols[i]] = params[paramIdx++];
              }
            }
          }

          // Generate ID if missing
          if (row.id === undefined || row.id === null) {
            row.id = this.state[table].reduce((max, x) => Math.max(max, typeof x.id === 'number' ? x.id : 0), 0) + 1;
          }
          if (!row.createdAt) row.createdAt = new Date().toISOString();

          // INSERT OR REPLACE: drop an existing row with the same id first.
          if (/OR\s+REPLACE/i.test(normalized) && row.id != null) {
            this.state[table] = this.state[table].filter((r) => r.id !== row.id);
          }

          this.state[table].push(row);
          this.save();
          return { lastInsertRowid: row.id, changes: 1 };
        }

        if (normalized.startsWith('DELETE')) {
          let colMatch = normalized.match(/WHERE\s+(\w+)\s*=/i);
          let col = colMatch ? colMatch[1].toLowerCase() : 'id';
          const val = params[0];
          // Stored rows keep camelCase keys (tokenHash, userId) but `col` is
          // lowercased above — match case-insensitively via ciGet, same as
          // get()/all() already do, or a DELETE on any non-lowercase column
          // silently matches nothing and "deletes" 0 rows every time.
          this.state[table] = this.state[table].filter(row => ciGet(row, col) !== val);
          this.save();
          return { changes: 1 };
        }

        if (normalized.startsWith('UPDATE')) {
          const setMatch = normalized.match(/SET\s+(.*?)\s+WHERE/i);
          const whereColMatch = normalized.match(/WHERE\s+(\w+)\s*=/i);
          const whereCol = whereColMatch ? whereColMatch[1].toLowerCase() : 'id';

          if (setMatch) {
            const assignments = setMatch[1].split(',').map((s) => s.trim());
            // SET placeholders come first; the first WHERE placeholder follows.
            const setParamCount = (setMatch[1].match(/\?/g) || []).length;
            const whereVal = params[setParamCount];
            const item = this.state[table].find((x) => ciGet(x, whereCol) === whereVal);

            if (item) {
              let pIdx = 0;
              for (const assignment of assignments) {
                const eq = assignment.indexOf('=');
                if (eq === -1) continue;
                const col = assignment.slice(0, eq).trim();
                const expr = assignment.slice(eq + 1).trim();
                const isCoalesce = /coalesce/i.test(expr);
                if (expr.includes('?')) {
                  const val = params[pIdx++];
                  // COALESCE(?, col): a null/undefined value keeps the old one.
                  if (!(isCoalesce && (val === null || val === undefined))) {
                    item[col] = val;
                  }
                } else if (/current_timestamp/i.test(expr)) {
                  item[col] = new Date().toISOString();
                } else if (/^-?\d+(\.\d+)?$/.test(expr)) {
                  item[col] = Number(expr);
                } else if (/^'.*'$/.test(expr)) {
                  item[col] = expr.slice(1, -1);
                }
              }
            }
          }
          this.save();
          return { changes: 1 };
        }

        return { changes: 0 };
      },

      get: (...params) => {
        if (!table || !this.state[table]) return undefined;

        let whereMatch = normalized.match(/WHERE\s+(.*?)(?:ORDER BY|LIMIT|$)/i);
        if (whereMatch) {
          let cond = whereMatch[1].trim();
          let colMatch = cond.match(/^(\w+)\s*=/);
          if (colMatch) {
            let col = colMatch[1].toLowerCase();
            const val = params[0];
            const found = this.state[table].find(row => ciGet(row, col) === val);
            return found;
          }
        }
        return this.state[table][0];
      },

      all: (...params) => {
        if (!table || !this.state[table]) return [];

        let filtered = [...this.state[table]];

        let whereMatch = normalized.match(/WHERE\s+(.*?)(?:ORDER BY|LIMIT|$)/i);
        if (whereMatch) {
          let cond = whereMatch[1].trim();
          let colMatch = cond.match(/^(\w+)\s*=/);
          if (colMatch) {
            let col = colMatch[1].toLowerCase();
            const val = params[0];
            filtered = filtered.filter(row => ciGet(row, col) === val);
          }
        }

        if (normalized.includes('ORDER BY')) {
          let orderColMatch = normalized.match(/ORDER BY\s+(\w+)/i);
          let orderCol = orderColMatch ? orderColMatch[1] : null;
          if (orderCol) {
            filtered.sort((a, b) => {
              let valA = a[orderCol];
              let valB = b[orderCol];
              if (normalized.includes('DESC')) {
                return valB > valA ? 1 : -1;
              } else {
                return valA > valB ? 1 : -1;
              }
            });
          }
        }

        if (normalized.includes('LIMIT')) {
          let limitVal = Number(normalized.match(/LIMIT\s+(\d+)/i)?.[1]);
          if (!isNaN(limitVal)) {
            filtered = filtered.slice(0, limitVal);
          }
        }

        return filtered;
      }
    };

    return stmt;
  }
}

export function getDb() {
  if (dbInstance) return dbInstance;
  dbInstance = new JSONDatabase(config.dbFile);
  return dbInstance;
}
