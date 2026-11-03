import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SfClient, resolveOrg } from './client.js';
import { describeTypes, listFolderType, listType, type Listed } from './mdapi.js';

const log = (msg: string) => process.stderr.write(`${msg}\n`);

export interface RetrieveOptions {
  org: string;
  out?: string;
  types?: string[];
  exclude: string[];
  all: boolean;
  includeManaged: boolean;
  standardObjects: boolean;
  parallel: number;
  dryRun: boolean;
  report?: string;
}

/** Large, binary or rarely wanted: skipped unless --all or named in --types. */
const DEFAULT_EXCLUDE = ['StaticResource', 'Document', 'ContentAsset', 'Report', 'Dashboard'];

/**
 * Retrieve cost per member relative to a light one (a class, layout, quick action: about 0.08 s each), measured on UAT:
 * an object with its fields is about 5x, a profile about 3x. Misjudging this leaves one slow job at the end.
 */
function weight(type: string, name: string): number {
  switch (type) {
    case 'CustomObject': return name.includes('__') ? 5 : 6;
    case 'Profile': return 3;
    case 'Flow':
    case 'PermissionSet': return 2;
    default: return 1;
  }
}
/**
 * Every sf retrieve costs about 12 s before any work starts, so fewer, larger jobs are cheaper; but a few giant jobs
 * leave workers idle and risk the 10,000-file / 39 MB retrieve limits. Aim for about three jobs per worker, within bounds.
 */
const JOBS_PER_WORKER = 3;
const MIN_JOB_WEIGHT = 150;
const MAX_JOB_WEIGHT = 1200;
const MAX_SPLIT_DEPTH = 3;

type Members = Map<string, string[]>;

interface Job {
  id: string;
  members: Members;
  depth: number;
}

interface Outcome {
  files: { type: string; fullName: string; state?: string }[];
  problems: string[];
  error?: string;
}

const keyOf = (type: string, name: string) => `${type}:${name}`;
const countMembers = (m: Members) => [...m.values()].reduce((n, a) => n + a.length, 0);
const describeJob = (m: Members) => [...m].map(([t, a]) => `${t}:${a.length}`).join(', ');

function manifest(members: Members, version: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const types = [...members].map(([t, a]) => `  <types>${a.map((m) => `<members>${esc(m)}</members>`).join('')}<name>${t}</name></types>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types}\n  <version>${version}</version>\n</Package>\n`;
}

/** One `sf project retrieve start` in its own throwaway project. `target` is validated by resolveOrg. */
function runSf(dir: string, target: string): Promise<Outcome> {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('sf', ['project', 'retrieve', 'start', '--manifest', 'package.xml', '--target-org', target, '--wait', '30', '--json'], { cwd: dir, shell: process.platform === 'win32' });
    p.stdout.on('data', (b) => (out += b));
    p.on('error', (e) => resolve({ files: [], problems: [], error: e.message }));
    p.on('close', () => {
      try {
        const r = JSON.parse(out.slice(out.indexOf('{')));
        const problems = (r.result?.messages ?? []).map((m: any) => String(m.problem ?? m.message ?? JSON.stringify(m)));
        if (r.status !== 0 && !r.result?.files?.length) return resolve({ files: [], problems, error: String(r.message ?? 'retrieve failed').split('\n')[0] });
        resolve({ files: (r.result?.files ?? []).map((f: any) => ({ type: f.type, fullName: f.fullName, state: f.state })), problems });
      } catch {
        resolve({ files: [], problems: [], error: 'could not read sf output' });
      }
    });
  });
}

/**
 * Windows keeps a folder busy for a while after sf exits, so deletion retries in the background (it must not block the
 * other jobs) and can never fail the run. The run waits for the stragglers before it exits.
 */
const pendingRemovals: Promise<unknown>[] = [];
function removeDir(dir: string): void {
  pendingRemovals.push(fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 }).catch(() => undefined));
}

/**
 * listMetadata returns nothing for StandardValueSet, but the names are fixed by Salesforce and retrieve by name works.
 * Names that do not exist in an org are simply not returned, so they are not reported as missing.
 */
const STANDARD_VALUE_SETS = [
  'AccountContactMultiRoles', 'AccountContactRole', 'AccountOwnership', 'AccountRating', 'AccountType', 'AddressCountryCode', 'AddressStateCode',
  'AssetStatus', 'CampaignMemberStatus', 'CampaignStatus', 'CampaignType', 'CaseContactRole', 'CaseOrigin', 'CasePriority', 'CaseReason',
  'CaseStatus', 'CaseType', 'ContactRole', 'ContractContactRole', 'ContractStatus', 'EntitlementType', 'EventSubject', 'EventType',
  'FiscalYearPeriodName', 'FiscalYearPeriodPrefix', 'FiscalYearQuarterName', 'FiscalYearQuarterPrefix', 'IdeaCategory', 'IdeaMultiCategory',
  'IdeaStatus', 'IdeaThemeStatus', 'Industry', 'InvoiceStatus', 'LeadSource', 'LeadStatus', 'OpportunityCompetitor', 'OpportunityStage',
  'OpportunityType', 'OrderStatus', 'OrderType', 'PartnerRole', 'Product2Family', 'QuestionOrigin', 'QuickTextCategory', 'QuickTextChannel',
  'QuoteStatus', 'ResourceAbsenceType', 'SalesTeamRole', 'Salutation', 'ServiceAppointmentStatus', 'ServiceContractApprovalStatus',
  'ServiceTerritoryTypeCode', 'SocialPostClassification', 'SocialPostEngagementLevel', 'SocialPostReviewedStatus', 'SolutionStatus',
  'TaskPriority', 'TaskStatus', 'TaskSubject', 'TaskType', 'WorkOrderLineItemStatus', 'WorkOrderPriority', 'WorkOrderStatus', 'WorkTypeDefinitionMethod',
];

function copyInto(src: string, dest: string): void {
  if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true, force: true });
}

/** Default destination: the current project's default package directory, else ./retrieved/<alias>. */
function defaultOut(alias: string): string {
  try {
    const proj = JSON.parse(fs.readFileSync('sfdx-project.json', 'utf8'));
    const dir = (proj.packageDirectories ?? []).find((d: any) => d.default) ?? proj.packageDirectories?.[0];
    if (dir?.path) return path.resolve(dir.path, 'main', 'default');
  } catch {
    /* not inside an sfdx project */
  }
  return path.resolve('retrieved', alias);
}

async function pool<T>(items: T[], n: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  }));
}

export async function retrieveAll(opts: RetrieveOptions): Promise<void> {
  const t0 = Date.now();
  const org = await resolveOrg(opts.org);
  const c = new SfClient(org, 10);
  const warnings: string[] = [];
  const out = path.resolve(opts.out ?? defaultOut(org.alias));
  log(`Retrieving from ${org.alias} (${org.instanceUrl}), API v${org.apiVersion} (read-only)`);

  // ---- 1. What can this org retrieve, and what exists? -------------------------------------------------------------
  const types = await describeTypes(c);
  const children = new Set(types.flatMap((t) => t.children));
  const known = new Set(types.map((t) => t.name));
  let chosen = types;
  if (opts.types?.length) {
    for (const t of opts.types) if (!known.has(t)) warnings.push(`Unknown metadata type "${t}" skipped`);
    chosen = types.filter((t) => opts.types!.includes(t.name));
  } else {
    const skip = new Set([...(opts.all ? [] : DEFAULT_EXCLUDE), ...opts.exclude]);
    // Child types (CustomField, ValidationRule, ...) arrive with their parent object.
    chosen = types.filter((t) => !children.has(t.name) && !skip.has(t.name));
  }

  const listed = new Map<string, Listed[]>();
  await timed(`list ${chosen.length} types`, () =>
    Promise.all(
      chosen.map(async (t) => {
        try {
          let items = t.inFolder ? await listFolderType(c, t.name) : await listType(c, t.name);
          if (!opts.includeManaged) items = items.filter((i) => !i.namespace);
          if (t.name === 'CustomObject' && !opts.standardObjects) items = items.filter((i) => i.fullName.includes('__'));
          if (items.length) listed.set(t.name, [...new Map(items.map((i) => [i.fullName, i])).values()]);
        } catch (e) {
          warnings.push(`${t.name}: could not list (${(e as Error).message.split('\n')[0]})`);
        }
      }),
    ),
  );
  // Types whose names are known but cannot be listed: retrieve by name and do not count absent names as missing.
  const optional = new Set<string>();
  if (chosen.some((t) => t.name === 'StandardValueSet') && !listed.has('StandardValueSet')) {
    listed.set('StandardValueSet', STANDARD_VALUE_SETS.map((fullName) => ({ fullName })));
    optional.add('StandardValueSet');
  }
  const total = [...listed.values()].reduce((n, a) => n + a.length, 0);
  const standardObjs = (listed.get('CustomObject') ?? []).filter((o) => !o.fullName.includes('__')).length;
  log(`  ${listed.size} types, ${total} members${standardObjs ? ` (incl. ${standardObjs} standard objects)` : ''}${opts.includeManaged ? '' : ', managed-package components skipped'}`);

  // ---- 2. Plan: balanced jobs. Heaviest members first so object-heavy jobs stay small and light types pack together. ----
  const flat: [string, string, number][] = [];
  for (const [t, items] of [...listed].sort((a, b) => weight(b[0], b[1][0]?.fullName ?? '') - weight(a[0], a[1][0]?.fullName ?? ''))) {
    for (const i of items.sort((a, b) => a.fullName.localeCompare(b.fullName))) flat.push([t, i.fullName, weight(t, i.fullName)]);
  }
  const jobs: Job[] = [];
  const jobWeight = Math.min(MAX_JOB_WEIGHT, Math.max(MIN_JOB_WEIGHT, Math.ceil(flat.reduce((n, f) => n + f[2], 0) / (opts.parallel * JOBS_PER_WORKER))));
  let cur: Members = new Map();
  let w = 0;
  const flush = () => {
    if (cur.size) jobs.push({ id: String(jobs.length + 1), members: cur, depth: 0 });
    cur = new Map();
    w = 0;
  };
  for (const [t, name, wt] of flat) {
    if (w + wt > jobWeight && w > 0) flush();
    (cur.get(t) ?? cur.set(t, []).get(t)!).push(name);
    w += wt;
  }
  flush();
  log(`  plan: ${jobs.length} jobs, ${opts.parallel} at a time -> ${out}`);

  if (opts.dryRun) {
    for (const [t, items] of [...listed].sort((a, b) => b[1].length - a[1].length)) log(`    ${t.padEnd(34)} ${items.length}`);
    for (const wn of warnings) log(`  ! ${wn}`);
    log('Dry run: nothing retrieved.');
    return;
  }

  // ---- 3. Retrieve in parallel, each job in its own temp project, merging into the destination as jobs finish ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-access-docs-retrieve-'));
  const cleanup = () => removeDir(tmp);
  process.once('SIGINT', () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    process.exit(130);
  });
  fs.mkdirSync(out, { recursive: true });

  const got = new Set<string>();
  const problems: string[] = [];
  const failed: string[] = [];
  let done = 0;
  let totalJobs = jobs.length;
  // Types this sf CLI has no definition for (it is older than the org's API). One of them in a manifest fails the whole
  // job, so it is dropped from that job and every later one, and reported at the end.
  const unsupported = new Map<string, number>();
  const dropUnsupported = (m: Members) => {
    for (const t of unsupported.keys()) m.delete(t);
  };

  /** Run one job; on failure retry once, then split it in half. Missing members are retried once on their own. */
  const execute = async (job: Job, attempt = 0): Promise<void> => {
    const t = Date.now();
    dropUnsupported(job.members);
    if (!job.members.size) return;
    const dir = path.join(tmp, `job-${job.id}-${attempt}`);
    fs.mkdirSync(path.join(dir, 'force-app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: org.apiVersion }));
    fs.writeFileSync(path.join(dir, 'package.xml'), manifest(job.members, org.apiVersion));
    const r = await runSf(dir, opts.org);

    if (r.error) {
      removeDir(dir);
      const bad = /registry for id '([^']+)'/.exec(r.error)?.[1];
      if (bad && job.members.has(bad)) {
        unsupported.set(bad, listed.get(bad)?.length ?? 0);
        log(`  ! this sf CLI does not know metadata type ${bad}; skipping it (update with: npm install -g @salesforce/cli)`);
        return execute(job, attempt);
      }
      if (attempt === 0) return execute(job, 1);
      const n = countMembers(job.members);
      if (n > 1 && job.depth < MAX_SPLIT_DEPTH) {
        log(`  ! job ${job.id} failed twice (${r.error}); splitting ${n} members in two`);
        totalJobs += 1;
        const [a, b] = split(job.members);
        await execute({ id: `${job.id}a`, members: a, depth: job.depth + 1 });
        await execute({ id: `${job.id}b`, members: b, depth: job.depth + 1 });
        return;
      }
      for (const [type, names] of job.members) for (const nm of names) failed.push(keyOf(type, nm));
      log(`  ! job ${job.id} gave up (${r.error}): ${describeJob(job.members)}`);
      return;
    }

    copyInto(path.join(dir, 'force-app', 'main', 'default'), out);
    removeDir(dir);
    for (const f of r.files) if (f.state !== 'Failed') got.add(keyOf(f.type, f.fullName));
    problems.push(...r.problems);

    // Verify: everything we asked for should have come back. Retry stragglers once, alone.
    const missing: Members = new Map();
    for (const [type, names] of job.members) {
      const lost = names.filter((nm) => !got.has(keyOf(type, nm)));
      if (lost.length) missing.set(type, lost);
    }
    if (countMembers(missing) && attempt < 2 && countMembers(missing) < countMembers(job.members)) {
      await execute({ id: `${job.id}r`, members: missing, depth: job.depth }, 2);
    }
    if (attempt < 2) log(`  [${++done}/${totalJobs}] job ${job.id}: ${countMembers(job.members)} members (${describeJob(job.members).slice(0, 80)}) ${((Date.now() - t) / 1000).toFixed(0)}s`);
  };

  try {
    await timed('retrieve', () => pool(jobs, opts.parallel, (job) => execute(job)));
  } finally {
    cleanup();
  }

  // ---- 4. What came back versus what was listed ---------------------------------------------------------------------
  const rows: { type: string; listed: number; retrieved: number; missing: string[]; unsupported?: boolean }[] = [];
  for (const [type, items] of listed) {
    if (unsupported.has(type)) {
      rows.push({ type, listed: items.length, retrieved: 0, missing: [], unsupported: true });
      continue;
    }
    const absent = items.filter((i) => !got.has(keyOf(type, i.fullName))).map((i) => i.fullName);
    // Names we could not list (StandardValueSet) that this org does not have are expected to be absent.
    rows.push({ type, listed: items.length, retrieved: items.length - absent.length, missing: optional.has(type) ? [] : absent });
  }
  rows.sort((a, b) => b.missing.length - a.missing.length || b.listed - a.listed);
  const lost = rows.filter((r) => r.missing.length);
  const retrievedTotal = rows.reduce((n, r) => n + r.retrieved, 0);
  const expected = rows.filter((r) => !r.unsupported && !optional.has(r.type)).reduce((n, r) => n + r.listed, 0) + rows.filter((r) => optional.has(r.type)).reduce((n, r) => n + r.retrieved, 0);
  log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${retrievedTotal} of ${expected} retrievable members retrieved into ${out}`);
  if (optional.has('StandardValueSet')) log(`  StandardValueSet: ${rows.find((r) => r.type === 'StandardValueSet')?.retrieved ?? 0} of ${STANDARD_VALUE_SETS.length} known value sets exist in this org`);
  if (unsupported.size) log(`  Skipped, not supported by this sf CLI: ${[...unsupported].map(([t, n]) => `${t}${n ? ` (${n})` : ''}`).join(', ')}. Update with: npm install -g @salesforce/cli`);
  if (lost.length) {
    log(`Not retrieved (listed but nothing came back; usually pseudo or inaccessible components):`);
    for (const r of lost.slice(0, 12)) log(`  ${r.type.padEnd(30)} ${r.missing.length} of ${r.listed}  e.g. ${r.missing.slice(0, 3).join(', ')}`);
  } else log('Every retrievable member was retrieved.');
  if (failed.length) log(`Jobs that gave up: ${failed.length} members, see report.`);
  for (const wn of warnings) log(`  ! ${wn}`);
  if (opts.report) {
    fs.writeFileSync(opts.report, JSON.stringify({ org: org.alias, at: new Date().toISOString(), out, total, types: rows, warnings, problems: problems.slice(0, 200), failed }, null, 2));
    log(`Report: ${path.resolve(opts.report)}`);
  }
  await Promise.all(pendingRemovals);
}

function split(m: Members): [Members, Members] {
  const flat = [...m].flatMap(([t, a]) => a.map((n) => [t, n] as const));
  const half = Math.ceil(flat.length / 2);
  const mk = (part: (readonly [string, string])[]) => {
    const r: Members = new Map();
    for (const [t, n] of part) (r.get(t) ?? r.set(t, []).get(t)!).push(n);
    return r;
  };
  return [mk(flat.slice(0, half)), mk(flat.slice(half))];
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const r = await fn();
  log(`  ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  return r;
}
