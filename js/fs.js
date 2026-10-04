/* ============================================================
   fs.js — Forge virtual filesystem
   Real persistence: IndexedDB, with a localStorage fallback for
   private-mode / restricted browsers. All reads are served from an
   in-memory Map so the editor and agent stay fast on low-end phones.
   ============================================================ */

const DB_NAME = 'forge-fs';
const STORE = 'files';
const LS_KEY = 'forge-files-fallback';

/** Normalise a project path: no leading slash, no "./", collapsed. */
export function normPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  s = s.replace(/^\.?\//, '').replace(/\/+/g, '/');
  s = s.replace(/^\/+/, '');
  if (!s) s = 'untitled.txt';
  return s;
}

export function extOf(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path || '');
  return m ? m[1].toLowerCase() : '';
}

export class VirtualFS {
  constructor() {
    this.cache = new Map();     // path -> content
    this.db = null;
    this.mode = 'memory';
    this._ready = false;
  }

  async init() {
    if (this._ready) return this;
    try {
      if (typeof indexedDB !== 'undefined') {
        this.db = await this._openDB();
        const rows = await this._idbAll();
        for (const r of rows) this.cache.set(r.path, r.content ?? '');
        this.mode = 'indexeddb';
      } else {
        throw new Error('no indexedDB');
      }
    } catch (e) {
      // fallback
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          const obj = JSON.parse(raw);
          for (const f of obj.files || []) this.cache.set(normPath(f.path), f.content ?? '');
        }
        this.mode = 'localstorage';
      } catch (e2) {
        this.mode = 'memory';
      }
    }
    this._ready = true;
    return this;
  }

  _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'path' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
  }

  _idbAll() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  _idbPut(rec) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  _idbDel(path) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(path);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  _idbClear() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  _persistFallback() {
    try {
      const files = [...this.cache.entries()].map(([path, content]) => ({ path, content }));
      localStorage.setItem(LS_KEY, JSON.stringify({ files }));
    } catch { /* ignore quota */ }
  }

  list() {
    return [...this.cache.keys()].sort((a, b) => a.localeCompare(b));
  }

  has(path) { return this.cache.has(normPath(path)); }

  read(path) {
    const p = normPath(path);
    if (!this.cache.has(p)) throw new Error(`File not found: ${p}`);
    return this.cache.get(p);
  }

  async write(path, content) {
    const p = normPath(path);
    const text = content == null ? '' : String(content);
    this.cache.set(p, text);
    if (this.mode === 'indexeddb' && this.db) {
      try { await this._idbPut({ path: p, content: text, updated: Date.now() }); }
      catch { this.mode = 'localstorage'; this._persistFallback(); }
    } else {
      this._persistFallback();
    }
    return p;
  }

  async writeMany(files) {
    for (const f of files) await this.write(f.path, f.content);
  }

  async remove(path) {
    const p = normPath(path);
    this.cache.delete(p);
    if (this.mode === 'indexeddb' && this.db) {
      try { await this._idbDel(p); } catch { this.mode = 'localstorage'; this._persistFallback(); }
    } else {
      this._persistFallback();
    }
  }

  async rename(oldPath, newPath) {
    const o = normPath(oldPath), n = normPath(newPath);
    if (!this.cache.has(o)) throw new Error(`File not found: ${o}`);
    if (o === n) return n;
    const content = this.cache.get(o);
    await this.remove(o);
    await this.write(n, content);
    return n;
  }

  async clear() {
    this.cache.clear();
    if (this.mode === 'indexeddb' && this.db) {
      try { await this._idbClear(); } catch { /* ignore */ }
    }
    this._persistFallback();
  }

  snapshot() {
    return this.list().map(path => ({ path, content: this.cache.get(path) }));
  }

  loadSnapshot(files) {
    for (const f of files || []) this.cache.set(normPath(f.path), f.content ?? '');
  }
}
