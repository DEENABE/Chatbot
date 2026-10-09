import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { serializeState, restoreCheckpoint } from './AgentState.js';
import { projectCheckpoint } from '../memory/runtime.js';

/** Atomic replacement, fsync before rename; errors stop execution. */
export function createCheckpointStore(
  directory = path.join(config.appDataPath, 'storage', 'agent-checkpoints'),
) {
  const fileFor = (id) => {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('Invalid checkpoint session ID');
    return path.join(directory, `${id}.json`);
  };
  const save = (value) => {
    const id = value.state.sessionId;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid checkpoint session ID');
    fs.mkdirSync(directory, { recursive: true });
    const target = fileFor(id);
    const temporary = `${target}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, serializeState(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    projectCheckpoint(value.state);
  };
  save.load = (id, ownerId) => {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT')
        throw Object.assign(new Error('Checkpoint not found.'), {
          status: 404,
        });
      throw error;
    }
    const state = restoreCheckpoint(value);
    if (!ownerId || state.ownerId !== ownerId)
      throw Object.assign(new Error('Checkpoint not found.'), { status: 404 });
    return value;
  };
  return save;
}
