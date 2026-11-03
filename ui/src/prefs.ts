import type { Principal, PrincipalKind } from '../../src/shared/resolve';
import type { Snapshot } from '../../src/shared/types';

/** UI state that survives a reload. Stored per org alias so UAT and prod keep separate selections. */
export interface UiState {
  kind: PrincipalKind;
  selected: Principal[];
  railQuery: string;
  onlyUsed: boolean;
  filter: string;
  /** Keys of the expanded sections. */
  open: string[];
  /** Include inactive triggers and flows. */
  showInactive: boolean;
  /** Toolbar state of the flow and LWC trace sections, by section key. */
  trace: Record<string, TraceUi>;
}

export type TraceGroupBy = 'object' | 'kind' | 'none';

export interface TraceUi {
  q: string;
  /** Entry-type chip: 'all' or a TraceKind. */
  kind: string;
  by: TraceGroupBy;
  /** Hide rows that carry a warning (missing Run Flows or Apex access). */
  hideWarn: boolean;
}

export const DEFAULT_TRACE: TraceUi = { q: '', kind: 'all', by: 'object', hideWarn: false };

const sanitizeTrace = (v: unknown): TraceUi => {
  const t = (v ?? {}) as Partial<TraceUi>;
  return {
    q: typeof t.q === 'string' ? t.q : '',
    kind: typeof t.kind === 'string' ? t.kind : 'all',
    by: t.by === 'kind' || t.by === 'none' ? t.by : 'object',
    hideWarn: t.hideWarn === true,
  };
};

const KINDS: PrincipalKind[] = ['profile', 'permset', 'group', 'user'];

export const DEFAULT_UI: UiState = { kind: 'profile', selected: [], railQuery: '', onlyUsed: true, filter: '', open: [], showInactive: false, trace: {} };

const storageKey = (alias: string) => `ui-state:${alias}`;

/** Read stored state, dropping anything malformed or no longer present in the snapshot. */
export function loadUi(alias: string, snap: Snapshot): UiState {
  try {
    const raw = localStorage.getItem(storageKey(alias));
    if (!raw) return DEFAULT_UI;
    const p = JSON.parse(raw) as Partial<UiState>;
    const psIds = new Set(snap.permissionSets.map((x) => x.id));
    const userIds = new Set(snap.users.map((u) => u.id));
    const exists = (s: Principal) => (s.kind === 'user' ? userIds.has(s.id) : psIds.has(s.id));
    return {
      kind: KINDS.includes(p.kind as PrincipalKind) ? (p.kind as PrincipalKind) : DEFAULT_UI.kind,
      selected: Array.isArray(p.selected)
        ? p.selected.filter((s): s is Principal => !!s && KINDS.includes(s.kind) && typeof s.id === 'string' && typeof s.label === 'string' && exists(s))
        : [],
      railQuery: typeof p.railQuery === 'string' ? p.railQuery : '',
      onlyUsed: typeof p.onlyUsed === 'boolean' ? p.onlyUsed : true,
      filter: typeof p.filter === 'string' ? p.filter : '',
      open: Array.isArray(p.open) ? p.open.filter((k): k is string => typeof k === 'string') : [],
      showInactive: p.showInactive === true,
      trace: Object.fromEntries(['flowTrace', 'lwcTrace'].map((k) => [k, sanitizeTrace((p.trace as Record<string, unknown> | undefined)?.[k])])),
    };
  } catch {
    return DEFAULT_UI;
  }
}

export function saveUi(alias: string, state: UiState): void {
  try {
    localStorage.setItem(storageKey(alias), JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
}
