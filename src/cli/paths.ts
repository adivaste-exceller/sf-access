import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo (or installed package) root: the nearest parent of this file that holds our package.json. */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'sf-access-docs') return dir;
      } catch { /* keep walking */ }
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/**
 * Where snapshots live. Same place no matter which folder the command is run from:
 * $SF_ACCESS_DOCS_HOME if set, else <repo>/snapshots. When installed as a package (inside node_modules,
 * where writing is wrong) it falls back to ./snapshots in the current folder.
 */
export function snapshotsRoot(): string {
  if (process.env.SF_ACCESS_DOCS_HOME) return path.resolve(process.env.SF_ACCESS_DOCS_HOME);
  const root = packageRoot();
  return root.includes(`${path.sep}node_modules${path.sep}`) ? path.resolve('snapshots') : path.join(root, 'snapshots');
}

/** Folder-safe version of an org alias or username. */
export function safeName(org: string): string {
  return org.replace(/[^\w.@+-]/g, '_');
}

export interface SnapshotInfo {
  dir: string;
  name: string;
  alias: string;
  instanceUrl: string;
  extractedAt: string;
}

/** Every snapshot under the standard root, newest first. */
export function listSnapshots(): SnapshotInfo[] {
  const root = snapshotsRoot();
  if (!fs.existsSync(root)) return [];
  const out: SnapshotInfo[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      out.push({ dir, name: e.name, alias: m.alias ?? e.name, instanceUrl: m.instanceUrl ?? '', extractedAt: m.extractedAt ?? '' });
    } catch { /* not a snapshot */ }
  }
  return out.sort((a, b) => b.extractedAt.localeCompare(a.extractedAt));
}
