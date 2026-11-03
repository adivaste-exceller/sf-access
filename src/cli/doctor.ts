import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { listOrgs } from './orgs.js';
import { listSnapshots, packageRoot, snapshotsRoot } from './paths.js';

/** Check the machine is ready and say exactly how to fix anything that is not. Returns true when nothing blocks extraction. */
export async function doctor(): Promise<boolean> {
  let ok = true;
  const line = (good: boolean | null, msg: string, fix?: string) => {
    process.stdout.write(`${good === null ? ' -' : good ? ' ✓' : ' ✗'} ${msg}\n`);
    if (!good && fix) process.stdout.write(`     fix: ${fix}\n`);
    if (good === false) ok = false;
  };

  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20, `Node ${process.versions.node}`, 'install Node 20 or later from https://nodejs.org');

  let sfVersion: string | undefined;
  try {
    const out = await new Promise<string>((resolve, reject) => execFile('sf', ['--version'], { shell: true }, (e, so) => (e ? reject(e) : resolve(so))));
    sfVersion = out.trim().split('\n')[0];
  } catch { /* handled below */ }
  line(!!sfVersion, sfVersion ? `Salesforce CLI: ${sfVersion}` : 'Salesforce CLI (sf) not found', 'install it with: npm install -g @salesforce/cli   (https://developer.salesforce.com/tools/salesforcecli)');

  if (sfVersion) {
    try {
      const orgs = await listOrgs();
      const live = orgs.filter((o) => o.connected);
      line(live.length > 0, `${live.length} connected org(s)${orgs.length > live.length ? `, ${orgs.length - live.length} need re-login` : ''}`, 'log in with: sf org login web --alias <name>   (add --instance-url https://test.salesforce.com for a sandbox)');
      for (const o of live) process.stdout.write(`     ${o.alias || o.username}  [${o.kind}]\n`);
    } catch (e) {
      line(false, `could not list orgs: ${(e as Error).message}`, 'run "sf org list" to see the error');
    }
  }

  const root = packageRoot();
  line(fs.existsSync(path.join(root, 'ui-dist', 'index.html')), 'UI build present', 'run: npm run build');
  const snaps = listSnapshots();
  line(null, `snapshots folder: ${snapshotsRoot()}  (${snaps.length} snapshot${snaps.length === 1 ? '' : 's'})`);

  process.stdout.write(ok ? '\nReady. Next: npm run extract\n' : '\nFix the items marked ✗ and run "npm run doctor" again.\n');
  return ok;
}
