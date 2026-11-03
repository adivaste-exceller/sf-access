import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const log = (msg: string) => process.stderr.write(`${msg}\n`);

/**
 * Wildcard retrieves. Every sf call has a large fixed cost, so types are batched; LWC (the most files) goes alone, and a
 * batch that fails (for example on the retrieve size limit) is retried one type at a time.
 */
const BATCHES: string[][] = [
  ['QuickAction', 'Layout', 'FlexiPage', 'Flow', 'AuraDefinitionBundle', 'ApexPage', 'CustomTab', 'CustomApplication'],
  ['LightningComponentBundle'],
];

/** Run an sf command in `cwd`. Arguments are fixed strings or validated, and file names are relative (no spaces). */
function sf(args: string[], cwd: string): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile('sf', [...args, '--json'], { cwd, shell: process.platform === 'win32', maxBuffer: 256 << 20 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout.slice(stdout.indexOf('{'))));
      } catch {
        reject(new Error(`sf ${args.slice(0, 3).join(' ')} failed${err ? `: ${err.message.split('\n')[0]}` : ''}`));
      }
    });
  });
}

function manifest(types: { name: string; members: string[] }[], version: string): string {
  const body = types.map((t) => `  <types>${t.members.map((m) => `<members>${m.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</members>`).join('')}<name>${t.name}</name></types>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}\n  <version>${version}</version>\n</Package>\n`;
}

export interface Retrieved {
  /** Root of the retrieved source (force-app/main/default). */
  dir: string;
  /** Temp project folder to delete when done (unless kept). */
  project: string;
  files: number;
}

/**
 * Retrieve the metadata needed to trace entry points into a temporary sfdx project. This only reads from the org;
 * the files land in a local folder. `target` must already be validated.
 */
export async function retrieveMetadata(target: string, apiVersion: string, warnings: string[], keepDir?: string): Promise<Retrieved> {
  if (!/^[\w.@+-]+$/.test(target)) throw new Error(`Invalid org alias/username: ${target}`);
  const project = keepDir ? path.resolve(keepDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'sf-access-docs-md-'));
  fs.mkdirSync(path.join(project, 'force-app'), { recursive: true });
  fs.writeFileSync(path.join(project, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: apiVersion }));
  let files = 0;

  let n = 0;
  /** Returns true on success. Failures are logged and left to the caller to warn about. */
  const retrieve = async (label: string, xml: string, quiet = false): Promise<boolean> => {
    const t = Date.now();
    const file = `package-${++n}.xml`;
    fs.writeFileSync(path.join(project, file), xml);
    try {
      const r = await sf(['project', 'retrieve', 'start', '--manifest', file, '--target-org', target, '--wait', '30'], project);
      if (r.status !== 0) throw new Error(r.message ?? 'retrieve failed');
      const got = r.result?.files?.length ?? 0;
      files += got;
      log(`    ${label}: ${got} files (${((Date.now() - t) / 1000).toFixed(1)}s)`);
      return true;
    } catch (e) {
      if (!quiet) {
        const msg = `Metadata ${label} skipped: ${(e as Error).message.split('\n')[0]}`;
        warnings.push(msg);
        log(`  ! ${msg}`);
      } else log(`    ${label} failed (${(e as Error).message.split('\n')[0]}), retrying one type at a time`);
      return false;
    }
  };

  for (const batch of BATCHES) {
    const ok = await retrieve(batch.join(', '), manifest(batch.map((name) => ({ name, members: ['*'] })), apiVersion), batch.length > 1);
    if (!ok && batch.length > 1) for (const type of batch) await retrieve(type, manifest([{ name: type, members: ['*'] }], apiVersion));
  }

  // Custom buttons and links cannot be retrieved with a wildcard: list the unmanaged ones, then retrieve by name.
  try {
    const listed = await sf(['org', 'list', 'metadata', '--metadata-type', 'WebLink', '--target-org', target], project);
    const names: string[] = (listed.result ?? []).filter((m: any) => !m.namespacePrefix).map((m: any) => m.fullName);
    for (let i = 0; i < names.length; i += 300) {
      await retrieve(`WebLink ${i + 1}-${Math.min(i + 300, names.length)} of ${names.length}`, manifest([{ name: 'WebLink', members: names.slice(i, i + 300) }], apiVersion));
    }
  } catch (e) {
    warnings.push(`Metadata WebLink skipped: ${(e as Error).message.split('\n')[0]}`);
  }

  return { dir: path.join(project, 'force-app', 'main', 'default'), project, files };
}

export function cleanup(r: Retrieved, kept: boolean): void {
  if (!kept) fs.rmSync(r.project, { recursive: true, force: true });
}
