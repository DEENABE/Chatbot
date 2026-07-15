import { BaseAgent } from './BaseAgent.js';

export class FileRepairAgent extends BaseAgent {
  constructor() {
    super({
      domain: 'file',
      title: 'File Repair Agent',
      expertise:
        'You specialize in files and folders: missing/hidden files, permissions and access-denied errors, ownership, Explorer issues, and filesystem/system-file corruption. You never delete or overwrite user data automatically — you recommend it.'
    });
  }
}

export default FileRepairAgent;
