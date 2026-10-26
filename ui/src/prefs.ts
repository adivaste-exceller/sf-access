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
}

const KINDS: PrincipalKind[] = ['profile', 'permset', 'group', 'user'];

export const DEFAULT_UI: UiState = { kind: 'profile', selected: [], railQuery: '', onlyUsed: true, filter: '', open: [], showInactive: false };

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
