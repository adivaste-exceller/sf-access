import { OPTIONAL_SNAPSHOT_FILES, SNAPSHOT_FILES, type Snapshot } from '../../src/shared/types';

const OPTIONAL = new Set<string>(OPTIONAL_SNAPSHOT_FILES);

/** Load every snapshot file in parallel. Files added in later versions are optional so older snapshots still open. */
export async function loadSnapshot(): Promise<Snapshot> {
  const parts = await Promise.all(
    SNAPSHOT_FILES.map(async (name) => {
      const res = await fetch(`/snapshot/${name}.json`);
      const isJson = res.ok && (res.headers.get('content-type') ?? '').includes('json');
      if (!isJson) {
        if (OPTIONAL.has(name)) return [name, []] as const;
        throw new Error(`Could not load ${name}.json (${res.status}). Run "sf-access-docs extract" first.`);
      }
      return [name, await res.json()] as const;
    }),
  );
  return Object.fromEntries(parts) as unknown as Snapshot;
}
