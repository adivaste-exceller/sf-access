import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { projectOrg } from './client.js';
import { doctor } from './doctor.js';
import { extract } from './extract.js';
import { chooseOrg, chooseSnapshot, isInteractive } from './orgs.js';
import { listSnapshots, safeName, snapshotsRoot } from './paths.js';
import { retrieveAll } from './retrieve.js';
import { serve } from './serve.js';

const program = new Command('sf-access-docs').description('Explore who can access what in a Salesforce org.');

interface ExtractFlags {
  targetOrg?: string; out?: string; fields: boolean; includePortal: boolean; metadata: boolean;
  keepMetadata?: string; detectTests: boolean; concurrency: string;
}

/** Run an extract. With no --target-org, ask which org (always asks, so production is never hit silently). Returns the snapshot folder. */
async function runExtract(o: ExtractFlags): Promise<string> {
  let org = o.targetOrg;
  if (!org) {
    if (!isInteractive()) throw new Error('Pass --target-org <alias> (no terminal to ask which org).');
    org = await chooseOrg();
  }
  const out = o.out ?? path.join(snapshotsRoot(), safeName(org));
  await extract({
    org,
    out,
    fields: o.fields,
    includePortal: o.includePortal,
    detectTests: o.detectTests,
    metadata: o.metadata || !!o.keepMetadata,
    keepMetadata: o.keepMetadata,
    concurrency: Math.max(1, Math.min(12, Number(o.concurrency) || 6)),
  });
  return out;
}

/** Turn --snapshot (a folder, or the name of one under the standard snapshots folder) into a folder; with none, pick one. */
async function resolveSnapshot(arg?: string): Promise<string> {
  if (arg) {
    const named = path.join(snapshotsRoot(), arg);
    return fs.existsSync(path.join(arg, 'meta.json')) || !fs.existsSync(path.join(named, 'meta.json')) ? arg : named;
  }
  const snaps = listSnapshots();
  if (!snaps.length) throw new Error(`No snapshots in ${snapshotsRoot()}. Run "npm run extract" first.`);
  if (snaps.length === 1 || !isInteractive()) return snaps[0]!.dir;
  return (await chooseSnapshot(snaps)).dir;
}

program
  .command('extract')
  .description('Read access data from an org (read-only) into a snapshot folder')
  .option('-o, --target-org <alias>', 'sf CLI alias or username of the org (default: ask which org, so prod is never hit by accident)')
  .option('-d, --out <dir>', 'snapshot output folder (default: <repo>/snapshots/<alias>)')
  .option('--fields', 'also extract field-level permissions (large, slow)', false)
  .option('--include-portal', 'include portal/community/guest profiles and users', false)
  .option('--metadata', 'retrieve metadata (read-only, into a temp folder) to trace screen flows and LWCs from objects, quick actions, buttons, pages and tabs', false)
  .option('--keep-metadata <dir>', 'keep the retrieved metadata in this folder instead of deleting it')
  .option('--detect-tests', 'read Apex class bodies to flag test classes exactly (heavier; default is a name-based guess)', false)
  .option('--concurrency <n>', 'parallel API requests', '6')
  .action(async (o) => {
    await runExtract(o);
  });

program
  .command('retrieve')
  .description('Retrieve metadata in parallel using explicit package.xml members (includes standard objects and fields). Read-only for the org.')
  .option('-o, --target-org <alias>', 'sf CLI alias or username of the org (default: the target-org of the current sfdx project, like sf itself)')
  .option('-d, --out <dir>', 'destination (default: the current sfdx project\'s default package directory, else ./retrieved/<alias>)')
  .option('--types <list>', 'comma-separated metadata types to retrieve (default: everything except the heavy types)')
  .option('--exclude <list>', 'comma-separated types to skip', '')
  .option('--all', 'also retrieve StaticResource, Document, ContentAsset, Report and Dashboard', false)
  .option('--include-managed', 'include components from managed packages', false)
  .option('--no-standard-objects', 'skip standard objects (Account, Opportunity, ...)')
  .option('--parallel <n>', 'parallel sf retrieves (1-8)', '4')
  .option('--dry-run', 'list what would be retrieved and the job plan, without retrieving', false)
  .option('--report <file>', 'write a JSON report of what was listed, retrieved and missing')
  .action(async (o) => {
    const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const org = o.targetOrg ?? (await projectOrg());
    await retrieveAll({
      org,
      out: o.out,
      types: o.types ? list(o.types) : undefined,
      exclude: list(o.exclude),
      all: o.all,
      includeManaged: o.includeManaged,
      standardObjects: o.standardObjects,
      parallel: Math.max(1, Math.min(8, Number(o.parallel) || 4)),
      dryRun: o.dryRun,
      report: o.report,
    });
  });

program
  .command('serve')
  .description('Open the explorer UI for a snapshot')
  .option('-s, --snapshot <dir>', 'snapshot folder or name (default: the only snapshot, or pick one)')
  .option('-p, --port <n>', 'port (the next free one is used if busy)', '4780')
  .option('--no-open', 'do not open the browser')
  .action(async (o) => serve(await resolveSnapshot(o.snapshot), Number(o.port), o.open));

program
  .command('all')
  .description('Extract an org, then open the explorer for it')
  .option('-o, --target-org <alias>', 'sf CLI alias or username (default: ask)')
  .option('-p, --port <n>', 'port', '4780')
  .option('--no-open', 'do not open the browser')
  .action(async (o) => {
    const out = await runExtract({ targetOrg: o.targetOrg, fields: false, includePortal: false, metadata: false, detectTests: false, concurrency: '6' });
    await serve(out, Number(o.port), o.open);
  });

program
  .command('doctor')
  .description('Check Node, the Salesforce CLI, org logins and the UI build, and say how to fix anything missing')
  .action(async () => {
    if (!(await doctor())) process.exitCode = 1;
  });

program.parseAsync().catch((e) => {
  process.stderr.write(`Error: ${(e as Error).message}\n`);
  process.exit(1);
});
