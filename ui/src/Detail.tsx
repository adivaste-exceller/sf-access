import { useMemo, useRef, useState, type RefObject } from 'react';
import { ContextMenu, copyText, type MenuItem } from './ContextMenu';
import type { Effective, Index, Principal } from '../../src/shared/resolve';
import { looksLikeTestClass } from '../../src/shared/apex';
import { flowKind } from '../../src/shared/resolve';
import { FLD, OBJ } from '../../src/shared/types';
import { compileRules, type Rules } from './filters';
import { DEFAULT_LOOK, Icon, IconTile, LOOK } from './icons';

interface Row {
  key: string;
  name: string;
  sub?: string;
  /** Right-aligned plain text, e.g. org-wide default or expiry. */
  extra?: string;
  mask?: number;
  via?: string[];
  /** Apex classes: true for test classes. */
  test?: boolean;
}

interface SectionData {
  key: string;
  title: string;
  rows: Row[];
  /** Rows removed by exclusion rules. */
  hidden: number;
  flags?: [string, number][];
  note?: string;
}

const OBJ_FLAGS: [string, number][] = [['R', OBJ.R], ['C', OBJ.C], ['E', OBJ.E], ['D', OBJ.D], ['VA', OBJ.VA], ['MA', OBJ.MA]];
const FLD_FLAGS: [string, number][] = [['R', FLD.R], ['E', FLD.E]];
const ROW_PAGE = 150;

export const TYPE_TITLES: Record<string, string> = {
  ApexClass: 'Apex classes',
  ApexPage: 'Visualforce pages',
  FlowDefinition: 'Flows',
  TabSet: 'Apps',
  CustomPermission: 'Custom permissions',
  ConnectedApplication: 'Connected apps',
  ExternalClientApplication: 'External client apps',
  ExternalDataSource: 'External data sources',
  CustomEntityDefinition: 'Custom settings / metadata types',
  ExternalCredentialParameter: 'External credential principals',
};
// Shown first, in this order; remaining types follow alphabetically.
export const TYPE_ORDER = ['ApexClass', 'ApexPage', 'FlowDefinition', 'TabSet', 'CustomPermission', 'ConnectedApplication', 'ExternalClientApplication'];

export function sortTypes(types: Iterable<string>): string[] {
  return [...types].sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

function Flags({ mask, flags }: { mask: number; flags: [string, number][] }) {
  return (
    <span className="flags">
      {flags.map(([l, bit]) => (
        <span key={l} className={`flag ${mask & bit ? 'on' : ''}`}>
          {l}
        </span>
      ))}
    </span>
  );
}

type OnMenu = (e: React.MouseEvent, data: SectionData, row: Row | null) => void;

function Section({ data, filtering, open, onToggle, onMenu }: { data: SectionData; filtering: boolean; open: boolean; onToggle: () => void; onMenu: OnMenu }) {
  const { title, rows, hidden, flags, note, key } = data;
  const look = LOOK[key] ?? DEFAULT_LOOK;
  const [limit, setLimit] = useState(ROW_PAGE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const total = data.rows.length;
  const isOpen = open || (filtering && total > 0);
  if (total + hidden === 0) return null;
  const toggle = (k: string) => {
    const n = new Set(expanded);
    if (!n.delete(k)) n.add(k);
    setExpanded(n);
  };
  return (
    <section className={`section ${isOpen ? 'open' : ''}`}>
      <button className="section-head" data-nav="1" data-section="1" onClick={onToggle} onContextMenu={(e) => onMenu(e, data, null)} aria-expanded={isOpen}>
        <span className={`chev ${isOpen ? 'open' : ''}`}>
          <Icon name="chevron" size={14} />
        </span>
        <IconTile name={look.icon} hue={look.hue} />
        <span className="section-title">{title}</span>
        {hidden > 0 && <span className="muted small">{hidden} excluded</span>}
        <span className="count">{filtering ? `${total} match` : total}</span>
      </button>
      {isOpen && (
        <div className="section-body">
          {note && <div className="note small muted">{note}</div>}
          {rows.length === 0 && <div className="empty">{total === 0 && hidden > 0 && !filtering ? 'Everything here is excluded by your rules.' : 'No matches.'}</div>}
          {rows.slice(0, limit).map((r) => (
            <div key={r.key} className="row-wrap">
              <button className={`row ${r.via ? 'clickable' : ''}`} data-nav="1" aria-expanded={r.via ? expanded.has(r.key) : undefined} onClick={() => r.via && toggle(r.key)} onContextMenu={(e) => onMenu(e, data, r)}>
                <span className="row-main">
                  <span className="row-name">{r.name}</span>
                  {r.sub && <span className="row-sub mono">{r.sub}</span>}
                </span>
                {r.extra && <span className="row-extra small muted">{r.extra}</span>}
                {flags && r.mask !== undefined && <Flags mask={r.mask} flags={flags} />}
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
          {rows.length > limit && (
            <button className="more" data-nav="1" onClick={() => setLimit(limit + ROW_PAGE * 4)}>
              Show more ({rows.length - limit} left)
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const byName = (a: Row, b: Row) => a.name.localeCompare(b.name);

/** Raw rows per section key, before exclusion rules and the text filter. */
function buildRows(index: Index, eff: Effective, selected: Principal[], auto: ReturnType<Index['automation']>) {
  const s = index.s;
  const flowById = new Map((s.flows ?? []).map((f) => [f.id, f]));
  const objInfo = new Map(s.objects.map((o) => [o.n, o]));
  const sections = new Map<string, Row[]>();
  sections.set(
    'objects',
    [...eff.objects].map(([api, g]) => {
      const info = objInfo.get(api);
      return { key: api, name: info?.l ?? api, sub: api, extra: info?.owd ? `OWD ${info.owd}` : undefined, mask: g.mask, via: g.via };
    }),
  );
  sections.set('fields', [...eff.fields].map(([f, g]) => ({ key: f, name: f, mask: g.mask, via: g.via })));
  // Derived from object access, not granted: see Index.automation.
  sections.set('triggers', auto.triggers);
  sections.set('recordFlows', auto.flows);
  sections.set('tabs', [...eff.tabs].map(([n, g]) => ({ key: n, name: n, extra: g.mask & 2 ? 'Default on' : 'Default off', via: g.via })));
  sections.set('system', [...eff.system].map(([n, g]) => ({ key: n, name: n.replace(/([a-z])([A-Z])/g, '$1 $2'), sub: n, via: g.via })));

  for (const [id, g] of eff.setup) {
    const e = s.setupEntities[id];
    const t = e?.t ?? 'Unknown';
    const list = sections.get(t) ?? [];
    const row: Row = { key: id, name: e?.l ?? e?.n ?? id, sub: e?.l ? e.n : e && e.n !== id ? undefined : id, via: g.via };
    if (t === 'ApexClass' && e) row.test = s.meta.testDetection === 'body' ? !!e.test : looksLikeTestClass(e.n);
    if (t === 'FlowDefinition') {
      const f = flowById.get(id);
      if (f) row.extra = `${flowKind(f)}${f.a ? '' : ' · inactive'}`;
    }
    list.push(row);
    sections.set(t, list);
  }

  const people: Row[] = [];
  const sources: Row[] = [];
  const first = selected[0];
  if (first && selected.length === 1) {
    if (first.kind !== 'user') {
      for (const ui of index.holders.get(first.id) ?? []) {
        const u = s.users[ui];
        if (u) people.push({ key: u.id, name: u.name, sub: u.username, extra: u.profileName });
      }
    } else {
      const u = index.userById.get(first.id);
      if (u) {
        const prof = s.permissionSets[u.profile];
        if (prof) sources.push({ key: prof.id, name: prof.label, extra: 'Profile' });
        for (const a of index.assignmentsByUser.get(s.users.indexOf(u)) ?? []) {
          const ps = s.permissionSets[a.ps];
          if (ps) sources.push({ key: ps.id, name: ps.label, extra: `${ps.type === 'Group' ? 'Permission set group' : 'Permission set'}${a.expires ? ` · expires ${a.expires.slice(0, 10)}` : ''}` });
        }
      }
    }
  }
  sections.set('sources', sources);
  sections.set('people', people);
  for (const rows of sections.values()) rows.sort(byName);
  return sections;
}

interface DetailProps {
  index: Index;
  selected: Principal[];
  rules: Rules;
  filter: string;
  onFilter: (v: string) => void;
  filterRef: RefObject<HTMLInputElement>;
  open: Set<string>;
  onToggleOpen: (key: string) => void;
  showInactive: boolean;
  onShowInactive: (v: boolean) => void;
  /** Adds an exclusion pattern for a section key. */
  onExclude: (key: string, pattern: string) => void;
  onRemove: (p: Principal) => void;
}

// Sections rendered explicitly; every other key is a setup entity type and gets a generic section.
const FIXED_SECTIONS = new Set(['objects', 'fields', 'triggers', 'recordFlows', 'tabs', 'system', 'sources', 'people']);

// Sections whose rows are not metadata items, so excluding them makes no sense.
const NO_EXCLUDE = new Set(['sources', 'people']);

const accessOf = (d: SectionData, r: Row): string => (d.flags && r.mask !== undefined ? d.flags.filter(([, bit]) => r.mask! & bit).map(([l]) => l).join(' ') : (r.extra ?? ''));

/** Spreadsheet-ready table of what is currently shown in a section. */
function tableOf(d: SectionData): string {
  const head = ['Name', 'API name', ...(d.flags ? d.flags.map(([l]) => l) : ['Detail'])];
  const lines = d.rows.map((r) => [r.name, r.sub ?? '', ...(d.flags ? d.flags.map(([, bit]) => (r.mask! & bit ? 'Y' : '')) : [r.extra ?? ''])]);
  return [head, ...lines].map((cols) => cols.join('\t')).join('\n');
}

/** Tree-style keys over sections and rows: Up/Down/Home/End move, Right opens a section, Left closes it (or jumps to its header). */
function onSectionsKey(e: React.KeyboardEvent<HTMLDivElement>) {
  const active = document.activeElement as HTMLElement | null;
  if (!active?.dataset.nav) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (active.dataset.section) {
      const expanded = active.getAttribute('aria-expanded') === 'true';
      if ((e.key === 'ArrowRight') !== expanded) {
        e.preventDefault();
        active.click();
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      active.closest('.section')?.querySelector<HTMLElement>('[data-section]')?.focus();
    }
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const els = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]'));
  const i = els.indexOf(active);
  if (i < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : Math.min(els.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
  els[next]?.focus();
}

export function Detail({ index, selected, rules, filter, onFilter, filterRef, open, onToggleOpen, showInactive, onShowInactive, onExclude, onRemove }: DetailProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();
  const say = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  };
  const copy = async (text: string, what: string) => say((await copyText(text)) ? `Copied ${what}` : 'Copy failed');

  // Right-click on a row or a section header. Section-wide copies cover what is currently shown (after exclusions and the filter).
  const openMenu: OnMenu = (e, d, row) => {
    e.preventDefault();
    const items: MenuItem[] = [];
    const n = d.rows.length;
    if (row) {
      const api = row.sub ?? row.name;
      const acc = accessOf(d, row);
      items.push({ label: 'Copy name', onSelect: () => copy(row.name, 'name') });
      if (row.sub) items.push({ label: 'Copy API name', onSelect: () => copy(api, 'API name') });
      items.push({ label: 'Copy with access', hint: acc || undefined, onSelect: () => copy(`${row.name}${row.sub && row.sub !== row.name ? ` (${row.sub})` : ''}${acc ? ` — ${acc}` : ''}`, 'row') });
      items.push({ separator: true });
    }
    if (n > 0) {
      items.push({ label: `Copy all ${d.title.toLowerCase()}`, hint: `${n}`, onSelect: () => copy(d.rows.map((r) => r.name).join('\n'), `${n} names`) });
      if (d.rows.some((r) => r.sub)) items.push({ label: 'Copy all API names', hint: `${n}`, onSelect: () => copy(d.rows.map((r) => r.sub ?? r.name).join('\n'), `${n} API names`) });
      items.push({ label: 'Copy all with access (table)', hint: 'TSV', onSelect: () => copy(tableOf(d), `${n} rows as a table`) });
    }
    if (d.key === 'ApexClass' && n > 0) {
      const tests = d.rows.filter((r) => r.test);
      const rest = d.rows.filter((r) => !r.test);
      const how = index.s.meta.testDetection === 'body' ? '' : ' (by name)';
      items.push({ separator: true });
      items.push({ label: `Copy test classes only${how}`, hint: `${tests.length}`, onSelect: () => copy(tests.map((r) => r.name).join('\n'), `${tests.length} test classes`) });
      items.push({ label: `Copy Apex classes excluding tests${how}`, hint: `${rest.length}`, onSelect: () => copy(rest.map((r) => r.name).join('\n'), `${rest.length} non-test classes`) });
    }
    if (row && !NO_EXCLUDE.has(d.key)) {
      items.push({ separator: true });
      const pattern = row.sub ?? row.name;
      items.push({ label: `Exclude “${pattern.length > 28 ? `${pattern.slice(0, 27)}…` : pattern}”`, onSelect: () => { onExclude(d.key, pattern); say('Excluded. Manage under Exclusions'); } });
    }
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const eff = useMemo(() => index.effective(selected), [index, selected]);
  const auto = useMemo(() => index.automation(eff, showInactive), [index, eff, showInactive]);
  const raw = useMemo(() => buildRows(index, eff, selected, auto), [index, eff, selected, auto]);
  const compiled = useMemo(() => compileRules(rules), [rules]);

  // Apply exclusion rules (counts and stats reflect them), then the text filter.
  const q = filter.trim().toLowerCase();
  const filtering = q.length > 0;
  const visible = useMemo(() => {
    const out = new Map<string, { rows: Row[]; hidden: number }>();
    for (const [key, rows] of raw) {
      const kept = key === 'sources' || key === 'people' ? rows : rows.filter((r) => !compiled.excluded(key, [r.name, r.sub]));
      out.set(key, { rows: kept, hidden: rows.length - kept.length });
    }
    return out;
  }, [raw, compiled]);

  if (!selected.length) {
    const c = index.s.meta.counts;
    return (
      <div className="empty-state">
        <h2>Pick a profile, permission set, group or user</h2>
        <p className="muted">Shows everything granted directly: object, field, Apex class, page, flow, app, tab and system access, with the path that grants it.</p>
        <p className="muted small">
          {c.profiles} profiles · {c.permissionSets} permission sets · {c.groups} groups · {c.users} users
          {index.s.meta.includePortal ? '' : ' (portal and guest excluded)'}
        </p>
        {index.s.meta.warnings.length > 0 && <p className="muted small">{index.s.meta.warnings.length} extraction warning(s), see meta.json.</p>}
      </div>
    );
  }

  const match = (rows: Row[]) => (q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.sub?.toLowerCase().includes(q) || r.extra?.toLowerCase().includes(q)) : rows);
  const count = (key: string) => visible.get(key)?.rows.length ?? 0;
  const section = (key: string, title: string, extra: Partial<SectionData> = {}): SectionData => {
    const v = visible.get(key) ?? { rows: [], hidden: 0 };
    return { key, title, rows: match(v.rows), hidden: v.hidden, ...extra };
  };
  // For an unfiltered section the total is rows.length; with a text filter it is the matches.
  const types = sortTypes([...raw.keys()].filter((k) => !FIXED_SECTIONS.has(k)));

  const stats: [string, string][] = [['Objects', 'objects'], ['Triggers', 'triggers'], ['Record flows', 'recordFlows'], ['Apex classes', 'ApexClass'], ['VF pages', 'ApexPage'], ['Flows', 'FlowDefinition'], ['Apps', 'TabSet'], ['Tabs', 'tabs'], ['System perms', 'system']];
  const anyExcluded = [...visible.values()].some((v) => v.hidden > 0);

  return (
    <div className="detail">
      <div className="detail-head">
        <div className="chips">
          {selected.map((p) => (
            <span key={p.kind + p.id} className="chip big">
              <span className="muted small">{p.kind === 'permset' ? 'permission set' : p.kind}</span> {p.label}
              {selected.length > 1 && (
                <button className="x" onClick={() => onRemove(p)} aria-label={`Remove ${p.label}`}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        <div className="stats">
          {stats.map(([label, key]) => {
            const look = LOOK[key] ?? DEFAULT_LOOK;
            return (
              <div key={key} className={`stat h-${look.hue}`}>
                <Icon name={look.icon} size={56} stroke={1.35} className="stat-bg" />
                <div className="stat-n">{count(key)}</div>
                <div className="stat-l">{label}</div>
              </div>
            );
          })}
        </div>
        <div className="filter-row">
          <input
            ref={filterRef}
            className="input wide"
            placeholder="Filter across all sections…  ( Alt+F )"
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') filter ? onFilter('') : e.currentTarget.blur();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                document.querySelector<HTMLElement>('.sections [data-nav]')?.focus();
              }
            }}
          />
          <label className="check small muted" title="Triggers and record-triggered flows that are switched off">
            <input type="checkbox" checked={showInactive} onChange={(e) => onShowInactive(e.target.checked)} />
            Include inactive triggers &amp; flows
          </label>
          {anyExcluded && <span className="muted small">Exclusion rules are hiding some items</span>}
        </div>
      </div>

      <div className="sections" onKeyDown={onSectionsKey}>
        {(() => {
          // One place to render a section so every one shares the persisted open state.
          const render = (key: string, title: string, extra: Partial<SectionData> = {}) => {
            const data = section(key, title, extra);
            return <Section key={key} filtering={filtering} data={data} open={open.has(key)} onToggle={() => onToggleOpen(key)} onMenu={openMenu} />;
          };
          return (
            <>
              {render('objects', 'Objects', { flags: OBJ_FLAGS, note: 'R read · C create · E edit · D delete · VA view all · MA modify all. Click a row to see what grants it.' })}
              {render('triggers', 'Triggers on their objects', { note: 'Not granted: triggers run for anyone who changes the object. Listed when the selection has Create (insert), Edit (update) or Delete on it. Trigger logic is not evaluated, so read each row as "can fire".' })}
              {render('recordFlows', 'Record-triggered flows on their objects', { note: 'Not granted: they fire on record changes, like triggers, using the same Create/Edit/Delete rule. Entry conditions are not evaluated. Screen and other flows granted to them are under Flows.' })}
              {index.s.meta.hasFields ? (
                render('fields', 'Fields', { flags: FLD_FLAGS })
              ) : (
                <div className="section-hint small muted">Field permissions not extracted. Re-run with <code className="mono">--fields</code> to include them.</div>
              )}
              {types.map((t) => render(t, TYPE_TITLES[t] ?? t))}
              {render('tabs', 'Tabs')}
              {render('system', 'System permissions')}
              {render('sources', 'Permission sources')}
              {render('people', 'Assigned users')}
            </>
          );
        })()}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
