import { useEffect, useMemo, useRef, useState } from 'react';
import { Index, type Principal, type PrincipalKind } from '../../src/shared/resolve';
import type { Snapshot } from '../../src/shared/types';
import { Detail, TYPE_TITLES, sortTypes } from './Detail';
import { Rail } from './Rail';
import { Settings, type RuleTarget } from './Settings';
import { loadRules, saveRules, type Rules } from './filters';
import { Icon } from './icons';
import { DEFAULT_TRACE, loadUi, saveUi, type UiState } from './prefs';

const TAB_KEYS: PrincipalKind[] = ['profile', 'permset', 'group', 'user'];

function initialUi(snap: Snapshot): UiState {
  const ui = loadUi(snap.meta.alias, snap);
  // #profile=<name> deep link wins over the stored selection.
  const m = /^#profile=(.+)$/.exec(window.location.hash);
  if (m) {
    const name = decodeURIComponent(m[1]!).toLowerCase();
    const p = snap.permissionSets.find((x) => x.type === 'Profile' && x.label.toLowerCase() === name);
    if (p) return { ...ui, kind: 'profile', selected: [{ kind: 'profile', id: p.id, label: p.label }] };
  }
  return ui;
}

export function Workspace({ snap, theme, onTheme }: { snap: Snapshot; theme: 'dark' | 'light'; onTheme: () => void }) {
  const alias = snap.meta.alias;
  const index = useMemo(() => new Index(snap), [snap]);
  const [ui, setUi] = useState<UiState>(() => initialUi(snap));
  const [rules, setRules] = useState<Rules>(loadRules);
  // #exclusions opens the dialog directly (handy for screenshots and bookmarks).
  const [settingsOpen, setSettingsOpen] = useState(() => window.location.hash === '#exclusions');
  const searchRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const patch = (p: Partial<UiState>) => setUi((u) => ({ ...u, ...p }));
  useEffect(() => saveUi(alias, ui), [alias, ui]);
  useEffect(() => saveRules(rules), [rules]);

  // Global shortcuts: / or Ctrl/Cmd+K search the rail, Alt+F filters the sections, Alt+1-4 switch tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (settingsOpen) return;
      if ((e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
      } else if (e.altKey && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        patch({ kind: TAB_KEYS[Number(e.key) - 1]! });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  // Sections the exclusion dialog offers: the fixed ones plus every setup entity type present in the snapshot.
  const targets = useMemo<RuleTarget[]>(() => {
    const types = sortTypes(new Set(Object.values(snap.setupEntities).map((e) => e.t)));
    return [
      { key: 'objects', title: 'Objects' },
      { key: 'triggers', title: 'Triggers' },
      { key: 'recordFlows', title: 'Record-triggered flows' },
      ...(snap.meta.hasMetadata ? [{ key: 'flowTrace', title: 'Screen flows' }, { key: 'lwcTrace', title: 'LWCs' }] : []),
      ...(snap.meta.hasFields ? [{ key: 'fields', title: 'Fields' }] : []),
      ...types.map((t) => ({ key: t, title: TYPE_TITLES[t] ?? t })),
      { key: 'tabs', title: 'Tabs' },
      { key: 'system', title: 'System permissions' },
    ];
  }, [snap]);
  const ruleCount = Object.values(rules).filter((t) => t.trim()).length;
  const open = useMemo(() => new Set(ui.open), [ui.open]);
  const toggleOpen = (key: string) => patch({ open: open.has(key) ? ui.open.filter((k) => k !== key) : [...ui.open, key] });

  const { meta } = snap;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg className="logo" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <defs>
              {/* body: lighter top-left, deeper bottom-right */}
              <linearGradient id="logo-body" x1="3" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#ff6b93" />
                <stop offset="0.5" stopColor="#ec003f" />
                <stop offset="1" stopColor="#a8002b" />
              </linearGradient>
              {/* glossy reflection on the top-left corner, fading out by mid-height */}
              <linearGradient id="logo-gloss" x1="4" y1="2" x2="14" y2="13" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#fff" stopOpacity="0.75" />
                <stop offset="0.55" stopColor="#fff" stopOpacity="0.12" />
                <stop offset="1" stopColor="#fff" stopOpacity="0" />
              </linearGradient>
              {/* thin rim light along the upper-left edge */}
              <linearGradient id="logo-rim" x1="3" y1="2" x2="20" y2="20" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#fff" stopOpacity="0.9" />
                <stop offset="0.45" stopColor="#fff" stopOpacity="0.15" />
                <stop offset="1" stopColor="#fff" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path id="logo-shape" fill="url(#logo-body)" d="M11.884 2.007L11.998 2l.118.007l.059.008l.061.013l.111.034a1 1 0 0 1 .217.112l.104.082l.255.218a11 11 0 0 0 7.189 2.537l.342-.01a1 1 0 0 1 1.005.717a13 13 0 0 1-9.208 16.25a1 1 0 0 1-.502 0A13 13 0 0 1 2.54 5.718a1 1 0 0 1 1.005-.717a11 11 0 0 0 7.531-2.527l.263-.225l.096-.075a1 1 0 0 1 .217-.112l.112-.034a1 1 0 0 1 .119-.021z" />
            <path fill="url(#logo-gloss)" d="M11.884 2.007L11.998 2l.118.007l.059.008l.061.013l.111.034a1 1 0 0 1 .217.112l.104.082l.255.218a11 11 0 0 0 7.189 2.537l.342-.01a1 1 0 0 1 1.005.717a13 13 0 0 1-9.208 16.25a1 1 0 0 1-.502 0A13 13 0 0 1 2.54 5.718a1 1 0 0 1 1.005-.717a11 11 0 0 0 7.531-2.527l.263-.225l.096-.075a1 1 0 0 1 .217-.112l.112-.034a1 1 0 0 1 .119-.021z" />
            <path fill="none" stroke="url(#logo-rim)" strokeWidth="0.6" d="M11.884 2.007L11.998 2l.118.007l.059.008l.061.013l.111.034a1 1 0 0 1 .217.112l.104.082l.255.218a11 11 0 0 0 7.189 2.537l.342-.01a1 1 0 0 1 1.005.717a13 13 0 0 1-9.208 16.25a1 1 0 0 1-.502 0A13 13 0 0 1 2.54 5.718a1 1 0 0 1 1.005-.717a11 11 0 0 0 7.531-2.527l.263-.225l.096-.075a1 1 0 0 1 .217-.112l.112-.034a1 1 0 0 1 .119-.021z" />
          </svg>
          <span className="brand-name">Access Explorer</span>
        </div>
        <div className="topbar-right">
          <span className="chip mono" title={meta.instanceUrl}>
            {meta.alias}
          </span>
          <span className="muted small">extracted {new Date(meta.extractedAt).toLocaleString()}</span>
          <button className="btn with-icon" onClick={() => setSettingsOpen(true)}>
            <Icon name="sliders" size={13} /> Exclusions{ruleCount > 0 && <span className="count">{ruleCount}</span>}
          </button>
          <button className="btn" onClick={onTheme} aria-label="Toggle theme">
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>
      <Rail
        index={index}
        kind={ui.kind}
        onKind={(kind) => patch({ kind })}
        selected={ui.selected}
        onSelect={(selected) => patch({ selected })}
        query={ui.railQuery}
        onQuery={(railQuery) => patch({ railQuery })}
        onlyUsed={ui.onlyUsed}
        onOnlyUsed={(onlyUsed) => patch({ onlyUsed })}
        searchRef={searchRef}
      />
      <main className="main">
        <Detail
          index={index}
          selected={ui.selected}
          rules={rules}
          filter={ui.filter}
          onFilter={(filter) => patch({ filter })}
          filterRef={filterRef}
          open={open}
          onToggleOpen={toggleOpen}
          showInactive={ui.showInactive}
          onShowInactive={(showInactive) => patch({ showInactive })}
          trace={ui.trace}
          onTrace={(key, p) => setUi((u) => ({ ...u, trace: { ...u.trace, [key]: { ...DEFAULT_TRACE, ...u.trace[key], ...p } } }))}
          onExclude={(key, pattern) => setRules((r) => ((r[key] ?? '').split('\n').some((l) => l.trim() === pattern) ? r : { ...r, [key]: [(r[key] ?? '').replace(/\s+$/, ''), pattern].filter(Boolean).join('\n') }))}
          onRemove={(p: Principal) => patch({ selected: ui.selected.filter((s) => !(s.kind === p.kind && s.id === p.id)) })}
        />
      </main>
      {settingsOpen && <Settings targets={targets} rules={rules} onChange={setRules} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
