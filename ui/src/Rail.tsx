import { useMemo, useRef, useState, type RefObject } from 'react';
import type { Index, Principal, PrincipalKind } from '../../src/shared/resolve';

interface Item {
  id: string;
  label: string;
  sub: string;
  /** Number of users holding it; null for users themselves. */
  count: number | null;
}

const KINDS: { kind: PrincipalKind; label: string }[] = [
  { kind: 'profile', label: 'Profiles' },
  { kind: 'permset', label: 'Permission sets' },
  { kind: 'group', label: 'Groups' },
  { kind: 'user', label: 'Users' },
];

const PAGE = 300;

function itemsFor(index: Index, kind: PrincipalKind): Item[] {
  const s = index.s;
  if (kind === 'profile') return s.permissionSets.filter((p) => p.type === 'Profile').map((p) => ({ id: p.id, label: p.label, sub: '', count: index.holderCount(p.id) }));
  if (kind === 'permset')
    return s.permissionSets
      .filter((p) => p.type === 'Regular' || p.type === 'Standard')
      .map((p) => ({ id: p.id, label: p.label, sub: p.type === 'Standard' ? 'standard' : p.name, count: index.holderCount(p.id) }));
  if (kind === 'group') return s.groups.map((g) => ({ id: g.psId, label: g.label, sub: g.status, count: index.holderCount(g.psId) }));
  return s.users.map((u) => ({ id: u.id, label: u.name, sub: `${u.profileName} · ${u.username}`, count: null }));
}

export function Rail(props: {
  index: Index;
  kind: PrincipalKind;
  onKind: (k: PrincipalKind) => void;
  selected: Principal[];
  onSelect: (p: Principal[]) => void;
  query: string;
  onQuery: (q: string) => void;
  onlyUsed: boolean;
  onOnlyUsed: (v: boolean) => void;
  searchRef: RefObject<HTMLInputElement>;
}) {
  const { index, kind, onKind, selected, onSelect, query, onQuery, onlyUsed, onOnlyUsed, searchRef } = props;
  const [limit, setLimit] = useState(PAGE);
  const listRef = useRef<HTMLUListElement>(null);

  // Up/Down/Home/End move through the list; plain arrows also select (selection follows focus).
  const onListKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const els = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]'));
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : Math.min(els.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
    const el = els[next];
    el?.focus();
    if (el?.dataset.select && !(e.ctrlKey || e.metaKey || e.shiftKey)) el.click();
  };
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      listRef.current?.querySelector<HTMLElement>('[data-nav]')?.focus();
    } else if (e.key === 'Escape') {
      if (query) onQuery('');
      else e.currentTarget.blur();
    }
  };

  const all = useMemo(() => itemsFor(index, kind), [index, kind]);
  const counts = useMemo(
    () => ({
      profile: index.s.permissionSets.filter((p) => p.type === 'Profile').length,
      permset: index.s.permissionSets.filter((p) => p.type === 'Regular' || p.type === 'Standard').length,
      group: index.s.groups.length,
      user: index.s.users.length,
    }),
    [index],
  );
  const q = query.trim().toLowerCase();
  const filtered = all.filter((i) => (!onlyUsed || i.count === null || i.count > 0) && (!q || i.label.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q)));
  const hiddenUnused = kind === 'user' ? 0 : all.filter((i) => i.count === 0).length;

  const isSelected = (id: string) => selected.some((s) => s.kind === kind && s.id === id);
  const click = (item: Item, e: React.MouseEvent) => {
    const p: Principal = { kind, id: item.id, label: item.label };
    // Ctrl/Cmd/Shift-click combines principals of the same kind into a union view.
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const same = selected.filter((s) => s.kind === kind);
      onSelect(isSelected(item.id) ? same.filter((s) => s.id !== item.id) : [...same, p]);
    } else onSelect([p]);
  };

  return (
    <aside className="rail">
      <div className="tabs" role="tablist">
        {KINDS.map((k) => (
          <button key={k.kind} role="tab" aria-selected={kind === k.kind} className={`tab ${kind === k.kind ? 'on' : ''}`} onClick={() => { onKind(k.kind); setLimit(PAGE); }}>
            {k.label}
            <span className="count">{counts[k.kind]}</span>
          </button>
        ))}
      </div>
      <div className="rail-search">
        <input ref={searchRef} className="input" placeholder={`Search ${KINDS.find((k) => k.kind === kind)!.label.toLowerCase()}…  ( / )`} value={query} onKeyDown={onSearchKey} onChange={(e) => { onQuery(e.target.value); setLimit(PAGE); }} />
        {kind !== 'user' && (
          <label className="check small muted">
            <input type="checkbox" checked={onlyUsed} onChange={(e) => onOnlyUsed(e.target.checked)} />
            Only assigned{hiddenUnused > 0 && onlyUsed ? ` (${hiddenUnused} unassigned hidden)` : ''}
          </label>
        )}
      </div>
      <ul className="list" ref={listRef} onKeyDown={onListKey}>
        {filtered.slice(0, limit).map((i) => (
          <li key={i.id}>
            <button className={`item ${isSelected(i.id) ? 'on' : ''}`} data-nav="1" data-select="1" aria-pressed={isSelected(i.id)} onClick={(e) => click(i, e)}>
              <span className="item-main">
                <span className="item-label">{i.label}</span>
                {i.sub && <span className="item-sub">{i.sub}</span>}
              </span>
              {i.count !== null && <span className="count">{i.count}</span>}
            </button>
          </li>
        ))}
        {filtered.length > limit && (
          <li>
            <button className="more" data-nav="1" onClick={() => setLimit(limit + PAGE)}>
              Show {Math.min(PAGE, filtered.length - limit)} more ({filtered.length - limit} left)
            </button>
          </li>
        )}
        {filtered.length === 0 && <li className="empty">Nothing matches.</li>}
      </ul>
      <div className="rail-foot small muted">↑↓ move · / search · Alt+1–4 tabs · Ctrl+click combine</div>
    </aside>
  );
}
