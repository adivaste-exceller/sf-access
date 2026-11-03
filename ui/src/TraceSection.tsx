import { useMemo, useState } from 'react';
import type { TraceKind } from '../../src/shared/resolve';
import { Icon } from './icons';
import type { TraceGroupBy, TraceUi } from './prefs';
import type { OnMenu, Row, SectionData } from './rows';
import { SectionHead } from './SectionHead';

const KIND_LABEL: Record<TraceKind, string> = {
  quickAction: 'Quick action',
  button: 'Button',
  page: 'Lightning page',
  tab: 'Tab',
  vf: 'Visualforce',
  aura: 'Aura',
  lwc: 'LWC',
  flow: 'Flow',
  nested: 'Nested',
  inferred: 'Inferred',
};
// Chip and group order: direct ways in first, then weaker signals.
const KIND_ORDER: TraceKind[] = ['quickAction', 'button', 'page', 'tab', 'vf', 'aura', 'lwc', 'flow', 'nested', 'inferred'];
const BY: [TraceGroupBy, string][] = [['object', 'Object'], ['kind', 'Entry type'], ['none', 'None']];
/** Lists longer than this start with their groups collapsed. */
const AUTO_COLLAPSE_ABOVE = 40;
const ROW_PAGE = 200;

interface Group {
  name: string;
  rows: Row[];
}

export function TraceSection(props: {
  data: SectionData;
  filtering: boolean;
  open: boolean;
  onToggle: () => void;
  onMenu: OnMenu;
  ui: TraceUi;
  onUi: (patch: Partial<TraceUi>) => void;
}) {
  const { data, filtering, open, onToggle, onMenu, ui, onUi } = props;
  const [override, setOverride] = useState<Map<string, boolean>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(ROW_PAGE);

  const q = ui.q.trim().toLowerCase();
  // Search and the warnings toggle first: chip counts reflect them, so a chip never promises rows that are not there.
  const base = useMemo(
    () =>
      data.rows.filter(
        (r) =>
          !(ui.hideWarn && r.warn) &&
          (!q || `${r.name} ${r.sub ?? ''} ${r.group ?? ''} ${r.entry ?? ''} ${r.via?.join(' ') ?? ''}`.toLowerCase().includes(q)),
      ),
    [data.rows, q, ui.hideWarn],
  );
  const chips = useMemo(() => {
    const counts = new Map<TraceKind, number>();
    for (const r of base) for (const k of r.kinds ?? []) counts.set(k, (counts.get(k) ?? 0) + 1);
    return KIND_ORDER.filter((k) => counts.has(k)).map((k) => [k, counts.get(k)!] as const);
  }, [base]);
  const shown = useMemo(() => (ui.kind === 'all' ? base : base.filter((r) => r.kinds?.includes(ui.kind as TraceKind))), [base, ui.kind]);

  const groups = useMemo<Group[]>(() => {
    if (ui.by === 'none') return [{ name: '', rows: [...shown].sort((a, b) => a.name.localeCompare(b.name)) }];
    const m = new Map<string, Row[]>();
    for (const r of shown) {
      const g = ui.by === 'object' ? (r.group ?? '') : KIND_LABEL[r.kind ?? 'lwc'];
      const list = m.get(g) ?? [];
      list.push(r);
      m.set(g, list);
    }
    const out = [...m].map(([name, rows]) => ({ name, rows: ui.by === 'object' ? rows : [...rows].sort((a, b) => a.name.localeCompare(b.name)) }));
    if (ui.by === 'kind') out.sort((a, b) => KIND_ORDER.findIndex((k) => KIND_LABEL[k] === a.name) - KIND_ORDER.findIndex((k) => KIND_LABEL[k] === b.name));
    return out;
  }, [shown, ui.by]);

  const total = data.rows.length;
  const active = !!q || ui.kind !== 'all' || ui.hideWarn;
  const isOpen = open || (filtering && total > 0);
  const grouped = ui.by !== 'none';
  const defaultOpen = shown.length <= AUTO_COLLAPSE_ABOVE;
  // While searching, every matching group is open so results are never hidden behind a collapsed header.
  const groupOpen = (name: string) => !!q || (override.get(name) ?? defaultOpen);
  const setAll = (value: boolean) => setOverride(new Map(groups.map((g) => [g.name, value])));
  const toggleRow = (k: string) => {
    const n = new Set(expanded);
    if (!n.delete(k)) n.add(k);
    setExpanded(n);
  };
  const menuData = (rows: Row[], title = data.title): SectionData => ({ ...data, title, rows });

  if (total + data.hidden === 0) return null;

  let rendered = 0;
  return (
    <section className={`section ${isOpen ? 'open' : ''}`}>
      <SectionHead data={data} isOpen={isOpen} countText={active ? `${shown.length} / ${total}` : total} onToggle={onToggle} onMenu={(e, d, r) => onMenu(e, menuData(shown), r)} />
      {isOpen && (
        <div className="section-body">
          {data.note && <div className="note small muted">{data.note}</div>}
          <div className="toolbar">
            <input
              className="input toolbar-search"
              placeholder="Search name, object or entry point…"
              aria-label={`Search ${data.title}`}
              value={ui.q}
              onChange={(e) => onUi({ q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') ui.q ? onUi({ q: '' }) : e.currentTarget.blur();
                else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  e.currentTarget.closest('.section-body')?.querySelector<HTMLElement>('[data-nav]')?.focus();
                }
              }}
            />
            <div className="seg" role="group" aria-label="Group by">
              <span className="muted small">Group by</span>
              {BY.map(([v, label]) => (
                <button key={v} className={`seg-btn small ${ui.by === v ? 'on' : ''}`} aria-pressed={ui.by === v} onClick={() => onUi({ by: v })}>
                  {label}
                </button>
              ))}
            </div>
            <label className="check small muted" title="Hide rows that lack Run Flows / flow access or an Apex class they call">
              <input type="checkbox" checked={ui.hideWarn} onChange={(e) => onUi({ hideWarn: e.target.checked })} />
              Hide with warnings
            </label>
            {grouped && groups.length > 1 && (
              <span className="toolbar-links small">
                <button className="link" onClick={() => setAll(true)}>
                  Expand all
                </button>
                <button className="link" onClick={() => setAll(false)}>
                  Collapse all
                </button>
              </span>
            )}
          </div>
          <div className="chip-row" role="group" aria-label="Entry type">
            <button className={`fchip small ${ui.kind === 'all' ? 'on' : ''}`} aria-pressed={ui.kind === 'all'} onClick={() => onUi({ kind: 'all' })}>
              All <span className="muted">{base.length}</span>
            </button>
            {chips.map(([k, n]) => (
              <button key={k} className={`fchip small ${ui.kind === k ? 'on' : ''}`} aria-pressed={ui.kind === k} onClick={() => onUi({ kind: ui.kind === k ? 'all' : k })}>
                {KIND_LABEL[k]} <span className="muted">{n}</span>
              </button>
            ))}
          </div>

          {shown.length === 0 && <div className="empty">{total === 0 ? 'Everything here is hidden by your exclusion rules or filters.' : 'No matches. Clear the search or pick another entry type.'}</div>}
          {groups.map((g) => {
            const gOpen = !grouped || groupOpen(g.name);
            const rows = gOpen ? g.rows.slice(0, Math.max(0, limit - rendered)) : [];
            rendered += rows.length;
            return (
              <div key={g.name || 'all'} className="group">
                {grouped && (
                  <button
                    className="group-head small"
                    data-nav="1"
                    data-group="1"
                    aria-expanded={gOpen}
                    onClick={() => setOverride(new Map(override).set(g.name, !gOpen))}
                    onContextMenu={(e) => onMenu(e, menuData(g.rows, g.name || data.title), null)}
                  >
                    <span className={`chev sm ${gOpen ? 'open' : ''}`}>
                      <Icon name="chevron" size={12} />
                    </span>
                    <span>{g.name || 'No group'}</span>
                    <span className="count">{g.rows.length}</span>
                  </button>
                )}
                {rows.map((r) => (
                  <div key={r.key} className="row-wrap">
                    <button className="row clickable" data-nav="1" aria-expanded={expanded.has(r.key)} onClick={() => toggleRow(r.key)} onContextMenu={(e) => onMenu(e, menuData(shown), r)}>
                      <span className="row-main">
                        <span className="row-name">{r.name}</span>
                        {r.sub && r.sub !== r.name && <span className="row-sub mono">{r.sub}</span>}
                      </span>
                      {ui.by !== 'object' && r.obj && <span className="pill mono">{r.obj}</span>}
                      {ui.by !== 'kind' && r.kind && <span className={`pill pill-${r.kind}`}>{KIND_LABEL[r.kind]}</span>}
                      <span className="row-extra small muted">
                        {r.entry}
                        {r.more ? ` +${r.more}` : ''}
                      </span>
                      {r.warn && <span className="row-warn small">{r.warn}</span>}
                    </button>
                    {expanded.has(r.key) && r.via && (
                      <ul className="via">
                        {r.via.map((v) => (
                          <li key={v}>{v}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
          {shown.length > limit && (
            <button className="more" data-nav="1" onClick={() => setLimit(limit + ROW_PAGE)}>
              Show more ({shown.length - rendered} left)
            </button>
          )}
        </div>
      )}
    </section>
  );
}
