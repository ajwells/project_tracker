// The server's store. All data lives in one JSON file, written atomically.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StoreCore } from '../public/shared/store-core.js';

export { COLORS, DEP_TYPES, EXPORT_FORMAT, HttpError, SCHEMA_VERSION, STATUSES } from '../public/shared/store-core.js';

export class Store extends StoreCore {
  // With saving off, the file is still read at startup but never written.
  constructor(filePath, { saving = true, firmLeads = true } = {}) {
    super({ saving, firmLeads });
    this.filePath = filePath;
    if (existsSync(filePath)) {
      this.state = JSON.parse(readFileSync(filePath, 'utf8'));
    }
  }

  persist() {
    if (!this.saving) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state));
    renameSync(temp, this.filePath);
  }

  beforeImport() {
    if (!this.saving || !this.state.projects.length) return;
    const dir = join(dirname(this.filePath), 'backups');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(dir, `before-import-${stamp}.json`), JSON.stringify(this.exportAll()));
  }
}
