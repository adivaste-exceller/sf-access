import readline from 'node:readline/promises';
import { sfJson } from './client.js';
import type { SnapshotInfo } from './paths.js';

export interface OrgChoice {
  alias: string;
  username: string;
  kind: 'production' | 'sandbox' | 'scratch' | 'other';
  instanceUrl: string;
  connected: boolean;
}

export const isInteractive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

/** Every org the sf CLI is logged in to. */
export async function listOrgs(): Promise<OrgChoice[]> {
  const r = await sfJson(['org', 'list']);
  if (r.status !== 0 && !r.result) throw new Error(r.message ?? 'sf org list failed');
  const seen = new Set<string>();
  const orgs: OrgChoice[] = [];
  for (const group of Object.values<any>(r.result ?? {})) {
    if (!Array.isArray(group)) continue;
    for (const o of group) {
      if (!o?.username || seen.has(o.username)) continue;
      seen.add(o.username);
      const kind = o.isScratch ? 'scratch' : o.isSandbox ? 'sandbox' : o.isSandbox === false ? 'production' : 'other';
      orgs.push({
        alias: o.alias ?? '',
        username: o.username,
        kind,
        instanceUrl: o.instanceUrl ?? '',
        connected: !o.connectedStatus || /^connected$/i.test(o.connectedStatus),
      });
    }
  }
  return orgs.sort((a, b) => Number(b.connected) - Number(a.connected) || (a.alias || a.username).localeCompare(b.alias || b.username));
}

async function pick<T>(title: string, items: T[], label: (t: T) => string): Promise<T> {
  process.stderr.write(`${title}\n`);
  items.forEach((it, i) => process.stderr.write(`  ${String(i + 1).padStart(2)}) ${label(it)}\n`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const n = Number((await rl.question(`Choose 1-${items.length}: `)).trim());
      if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]!;
    }
  } finally {
    rl.close();
  }
}

/** Ask which org to extract from. Always asks, so production is never hit silently. */
export async function chooseOrg(): Promise<string> {
  const orgs = await listOrgs();
  if (!orgs.length) {
    throw new Error('No Salesforce orgs are logged in. Run: sf org login web --alias <name>   (add --instance-url https://test.salesforce.com for a sandbox)');
  }
  const o = await pick('Which org do you want to extract?', orgs, (x) => {
    const name = x.alias || x.username;
    const flag = x.kind === 'production' ? '  [PRODUCTION]' : x.kind === 'other' ? '' : `  [${x.kind}]`;
    return `${name}${x.alias ? `  (${x.username})` : ''}${flag}${x.connected ? '' : '  (not connected, re-login needed)'}`;
  });
  return o.alias || o.username;
}

export async function chooseSnapshot(snaps: SnapshotInfo[]): Promise<SnapshotInfo> {
  return pick('Which snapshot do you want to open?', snaps, (s) => `${s.name}  (${s.alias}, extracted ${s.extractedAt.slice(0, 16).replace('T', ' ') || 'unknown'})`);
}
