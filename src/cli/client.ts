import { execFile } from 'node:child_process';

export interface Org {
  alias: string;
  username: string;
  instanceUrl: string;
  accessToken: string;
  apiVersion: string;
}

/** Ask the sf CLI for a session for the org. Works with any authenticated alias or username. */
function sfJson(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    // shell: true so Windows can resolve sf.cmd; callers validate any user-supplied argument.
    execFile('sf', [...args, '--json'], { shell: true, maxBuffer: 20 << 20 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout.slice(stdout.indexOf('{'))));
      } catch {
        reject(new Error(`sf ${args.slice(0, 2).join(' ')} failed${err ? `: ${err.message}` : ''}`));
      }
    });
  });
}

/** Ask the sf CLI for a session for the org. Works with any authenticated alias or username. */
export async function resolveOrg(target: string): Promise<Org> {
  if (!/^[\w.@+-]+$/.test(target)) throw new Error(`Invalid org alias/username: ${target}`);
  // `org display` redacts the token in recent CLI versions, so the token comes from `org auth show-access-token`.
  const [info, tok] = await Promise.all([
    sfJson(['org', 'display', '--target-org', target]),
    sfJson(['org', 'auth', 'show-access-token', '--target-org', target]),
  ]);
  const accessToken: string | undefined = tok.result?.accessToken ?? (info.result?.accessToken?.startsWith('[REDACTED]') ? undefined : info.result?.accessToken);
  if (info.status !== 0 || !accessToken) {
    throw new Error(`sf could not open org "${target}": ${info.message ?? tok.message ?? 'no access token (re-authenticate with sf org login web)'}`);
  }
  const r = info.result;
  return { alias: r.alias ?? target, username: r.username, instanceUrl: r.instanceUrl, accessToken, apiVersion: r.apiVersion ?? '60.0' };
}

class Semaphore {
  private waiting: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SfClient {
  private sem: Semaphore;
  private refreshing: Promise<void> | null = null;
  requests = 0;

  constructor(public org: Org, concurrency = 6) {
    this.sem = new Semaphore(concurrency);
  }

  private async refreshToken(): Promise<void> {
    this.refreshing ??= resolveOrg(this.org.username).then((o) => {
      this.org.accessToken = o.accessToken;
    }).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async get(pathOrUrl: string, attempt = 0): Promise<any> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.org.instanceUrl + pathOrUrl;
    let res: Response;
    try {
      this.requests++;
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.org.accessToken}`, 'Sforce-Query-Options': 'batchSize=2000' },
      });
    } catch (e) {
      if (attempt < 4) {
        await sleep(500 * 2 ** attempt);
        return this.get(pathOrUrl, attempt + 1);
      }
      throw e;
    }
    if (res.status === 401 && attempt < 2) {
      await this.refreshToken();
      return this.get(pathOrUrl, attempt + 1);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return this.get(pathOrUrl, attempt + 1);
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 400)}`);
    return res.json();
  }

  /** Run a SOQL query to completion, following nextRecordsUrl. */
  query<T = any>(soql: string, tooling = false): Promise<T[]> {
    return this.sem.run(async () => {
      const base = `/services/data/v${this.org.apiVersion}/${tooling ? 'tooling/' : ''}query?q=`;
      let page = await this.get(base + encodeURIComponent(soql));
      const rows: T[] = page.records;
      while (!page.done && page.nextRecordsUrl) {
        page = await this.get(page.nextRecordsUrl);
        rows.push(...page.records);
      }
      return rows;
    });
  }

  /** Query with an `IN (...)` filter over many ids, chunked and run in parallel. */
  async queryIn<T = any>(ids: string[], size: number, build: (inList: string) => string, tooling = false, onChunk?: (done: number, total: number) => void): Promise<T[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
    let done = 0;
    const parts = await Promise.all(
      chunks.map(async (c) => {
        const rows = await this.query<T>(build(c.map((id) => `'${id}'`).join(',')), tooling);
        onChunk?.(++done, chunks.length);
        return rows;
      }),
    );
    return parts.flat();
  }

  describe(sobject: string): Promise<{ fields: { name: string }[] }> {
    return this.sem.run(() => this.get(`/services/data/v${this.org.apiVersion}/sobjects/${sobject}/describe`));
  }
}
