// Keeps projects in this browser, used when the server isn't saving data.
// localStorage is synchronous, so re-reading it before each change stops two
// open tabs from overwriting each other's work.

import { emptyState, HttpError, StoreCore } from '../shared/store-core.js';

export const STORAGE_KEY = 'tracker.store';

export class LocalStore extends StoreCore {
  constructor({ firmLeads = true } = {}) {
    super({ saving: false, firmLeads });
    this.load();
  }

  hasSavedCopy() {
    try {
      return localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  // Picks up what's stored, including changes from other tabs.
  load() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return; // storage is blocked, so keep what's in memory
    }
    if (raw === null) {
      this.state = emptyState();
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.projects)) throw new Error('No project list');
      this.state = parsed;
    } catch {
      // Set the unreadable copy aside instead of overwriting it with the next change.
      this.damaged = true;
      this.state = emptyState();
      try {
        localStorage.setItem(`${STORAGE_KEY}.damaged`, raw);
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Nothing more can be done from here.
      }
    }
  }

  persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      throw new HttpError(507, 'This browser could not store that change. It may be full or blocking site data. Export your projects to keep a copy.');
    }
  }
}
