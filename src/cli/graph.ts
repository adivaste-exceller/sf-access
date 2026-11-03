import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { LwcInfo, Route, RouteKind } from '../shared/types.js';

/**
 * Turns retrieved metadata into routes: entry points (quick actions, custom buttons, Lightning pages, tabs, Visualforce,
 * Aura) that lead to active screen flows, LWCs and Aura components. Routes are then passed down through containers, so a
 * flow reached from a quick action also routes the LWCs used as its screens, and so on.
 */

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
const arr = <T>(x: T | T[] | undefined | null): T[] => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const text = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);

const MAX_AT = 12;
const MAX_ROUTES_PER_TARGET = 40;
const INHERIT_ROUNDS = 4;

export interface GraphResult {
  routes: Route[];
  lwcs: LwcInfo[];
  stats: Record<string, number>;
}

interface Layout {
  name: string;
  obj: string;
  actions: Set<string>;
  buttons: Set<string>;
}
interface Page {
  name: string;
  label?: string;
  obj: string | null;
  type: string;
  flows: string[];
  lwcs: string[];
  actionNames: Set<string>;
}

const kebabToCamel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const stripC = (name: string | undefined): string | undefined => {
  if (!name) return undefined;
  if (name.startsWith('c:')) return name.slice(2);
  return name.includes(':') ? undefined : name; // other namespaces are packages we cannot read
};

export function buildGraph(dir: string): GraphResult {
  const sub = (d: string) => path.join(dir, d);
  const files = (d: string, ext: string) => (fs.existsSync(sub(d)) ? fs.readdirSync(sub(d)).filter((f) => f.endsWith(ext)) : []);
  const parse = (d: string, f: string): any => {
    try {
      return parser.parse(fs.readFileSync(path.join(sub(d), f), 'utf8'));
    } catch {
      return {};
    }
  };
  const raw = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  const baseName = (f: string, ext: string) => dec(f.slice(0, -ext.length));

  // ---- flows: only active screen flows can be reached by a user; every flow may contain screens or subflows
  const screenFlows = new Map<string, { label: string }>();
  const flowSubflows = new Map<string, string[]>();
  const flowLwcs = new Map<string, string[]>();
  for (const f of files('flows', '.flow-meta.xml')) {
    const name = baseName(f, '.flow-meta.xml');
    const x = parse('flows', f).Flow ?? {};
    if (x.processType === 'Flow' && x.status === 'Active') screenFlows.set(name, { label: text(x.label) ?? name });
    flowSubflows.set(name, arr<any>(x.subflows).map((s) => text(s.flowName)).filter((s): s is string => !!s));
    const src = raw(path.join(sub('flows'), f));
    flowLwcs.set(name, [...new Set([...src.matchAll(/<extensionName>c:([^<]+)<\/extensionName>/g)].map((m) => m[1]!))]);
  }

  // ---- layouts: which quick actions and buttons each one shows
  const layouts: Layout[] = [];
  for (const f of files('layouts', '.layout-meta.xml')) {
    const name = baseName(f, '.layout-meta.xml');
    const x = parse('layouts', f).Layout ?? {};
    const actions = new Set<string>();
    for (const i of arr<any>(x.quickActionList?.quickActionListItems)) if (text(i.quickActionName)) actions.add(i.quickActionName);
    for (const i of arr<any>(x.platformActionList?.platformActionListItems)) if (i.actionType === 'QuickAction' && text(i.actionName)) actions.add(i.actionName);
    const buttons = new Set<string>(arr<string>(x.customButtons).filter((b) => typeof b === 'string'));
    for (const rl of arr<any>(x.relatedLists)) for (const b of arr<string>(rl.customButtons)) if (typeof b === 'string') buttons.add(b);
    layouts.push({ name, obj: name.split('-')[0]!, actions, buttons });
  }

  // ---- apps and tabs: tell us which apps make a tab or an app/home/utility-bar page reachable
  const appTabs = new Map<string, string[]>();
  const pageApps = new Map<string, Set<string>>();
  const linkPageToApp = (page: string | undefined, app: string) => {
    if (!page) return;
    if (!pageApps.has(page)) pageApps.set(page, new Set());
    pageApps.get(page)!.add(app);
  };
  const tabInfo = new Map<string, { label?: string; lwc?: string; aura?: string; flexiPage?: string }>();
  for (const f of files('tabs', '.tab-meta.xml')) {
    const x = parse('tabs', f).CustomTab ?? {};
    tabInfo.set(baseName(f, '.tab-meta.xml'), { label: text(x.label), lwc: stripC(text(x.lwcComponent)), aura: stripC(text(x.auraComponent)), flexiPage: text(x.flexiPage) });
  }
  for (const f of files('applications', '.app-meta.xml')) {
    const app = baseName(f, '.app-meta.xml');
    const x = parse('applications', f).CustomApplication ?? {};
    for (const t of arr<string>(x.tabs)) {
      if (typeof t !== 'string') continue;
      appTabs.set(t, [...(appTabs.get(t) ?? []), app]);
      linkPageToApp(tabInfo.get(t)?.flexiPage, app);
    }
    linkPageToApp(text(x.utilityBar), app);
    for (const o of arr<any>(x.actionOverrides)) if (String(o.type).toLowerCase() === 'flexipage' && String(o.pageOrSobjectType ?? '').startsWith('standard-')) linkPageToApp(text(o.content), app);
  }

  // ---- Lightning pages
  const pages: Page[] = [];
  for (const f of files('flexipages', '.flexipage-meta.xml')) {
    const name = baseName(f, '.flexipage-meta.xml');
    const x = parse('flexipages', f).FlexiPage ?? {};
    const page: Page = { name, label: text(x.masterLabel), obj: text(x.sobjectType) ?? null, type: text(x.type) ?? '', flows: [], lwcs: [], actionNames: new Set() };
    for (const region of arr<any>(x.flexiPageRegions)) {
      for (const item of arr<any>(region.itemInstances)) {
        const ci = item.componentInstance;
        if (!ci) continue;
        const cn = text(ci.componentName) ?? '';
        const props = arr<any>(ci.componentInstanceProperties);
        if (cn === 'flowruntime:interview') {
          const fp = props.find((p) => p.name === 'flowName' || p.name === 'flowApiName');
          if (text(fp?.value)) page.flows.push(fp.value);
        } else if (cn.startsWith('c:')) page.lwcs.push(cn.slice(2));
        for (const p of props) if (p.name === 'actionNames') for (const v of arr<any>(p.valueList?.valueListItems)) if (text(v.value)) page.actionNames.add(v.value);
      }
    }
    pages.push(page);
  }

  // ---- LWC bundles
  const lwcs: LwcInfo[] = [];
  const lwcDeclared = new Map<string, string[]>();
  const lwcHtml = new Map<string, string>();
  const lwcJs = new Map<string, string>();
  for (const d of fs.existsSync(sub('lwc')) ? fs.readdirSync(sub('lwc')) : []) {
    const metaFile = path.join(sub('lwc'), d, `${d}.js-meta.xml`);
    if (!fs.existsSync(metaFile)) continue;
    const x = parser.parse(raw(metaFile)).LightningComponentBundle ?? {};
    const js = raw(path.join(sub('lwc'), d, `${d}.js`));
    const html = raw(path.join(sub('lwc'), d, `${d}.html`));
    lwcHtml.set(d, html);
    lwcJs.set(d, js);
    const schema = [...new Set([...js.matchAll(/@salesforce\/schema\/([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]!))];
    const apex = [...new Set([...js.matchAll(/@salesforce\/apex\/([A-Za-z0-9_.]+)\.[A-Za-z0-9_]+['"]/g)].map((m) => m[1]!))];
    lwcs.push({ n: d, l: text(x.masterLabel), targets: arr<string>(x.targets?.target).filter((t) => typeof t === 'string'), apex, schema });
    lwcDeclared.set(d, [...new Set(arr<any>(x.targetConfigs?.targetConfig).flatMap((tc) => arr<string>(tc.objects?.object)).filter((o) => typeof o === 'string'))]);
  }
  const lwcSet = new Set(lwcs.map((l) => l.n));
  const auraSet = new Set(fs.existsSync(sub('aura')) ? fs.readdirSync(sub('aura')).filter((d) => fs.statSync(path.join(sub('aura'), d)).isDirectory()) : []);

  // ---- routes
  const byTarget = new Map<string, Route[]>();
  const seen = new Set<string>();
  const valid = (t: Route['t'], x: string) => (t === 'flow' ? screenFlows.has(x) : t === 'lwc' ? lwcSet.has(x) : auraSet.has(x));
  const add = (r: Route): boolean => {
    if (!valid(r.t, r.x)) return false;
    const key = `${r.t}:${r.x}`;
    const id = `${key}|${r.k}|${r.o ?? ''}|${r.n}|${r.up ?? ''}`;
    if (seen.has(id)) return false;
    const list = byTarget.get(key) ?? [];
    if (list.length >= MAX_ROUTES_PER_TARGET) return false;
    seen.add(id);
    list.push({ ...r, at: r.at.slice(0, MAX_AT) });
    byTarget.set(key, list);
    return true;
  };
  const direct = (t: Route['t'], x: string | undefined, k: RouteKind, o: string | null, n: string, l: string | undefined, at: string[], ap?: string[]) => {
    if (x) add({ t, x, k, o, n, l, at, ap });
  };

  // quick actions
  const qaActionPlacements = (obj: string | null, full: string, name: string): string[] => {
    const hit = (act: string, where: string | null) => act === full || (act === name && (!obj || where === obj));
    return [
      ...layouts.filter((l) => [...l.actions].some((a) => hit(a, l.obj))).map((l) => `layout:${l.name}`),
      ...pages.filter((p) => [...p.actionNames].some((a) => hit(a, p.obj))).map((p) => `page:${p.name}`),
    ];
  };
  let quickActions = 0;
  for (const f of files('quickActions', '.quickAction-meta.xml')) {
    quickActions++;
    const full = baseName(f, '.quickAction-meta.xml');
    const dot = full.indexOf('.');
    const obj = dot > 0 ? full.slice(0, dot) : null;
    const name = dot > 0 ? full.slice(dot + 1) : full;
    const x = parse('quickActions', f).QuickAction ?? {};
    const at = qaActionPlacements(obj, full, name);
    if (x.type === 'Flow') direct('flow', text(x.flowDefinition), 'quickAction', obj, name, text(x.label), at);
    else if (x.type === 'LightningWebComponent') direct('lwc', stripC(text(x.lightningWebComponent)), 'quickAction', obj, name, text(x.label), at);
    else if (x.type === 'LightningComponent') direct('aura', stripC(text(x.lightningComponent)), 'quickAction', obj, name, text(x.label), at);
  }

  // Lightning pages: flow components and placed LWCs
  for (const p of pages) {
    const ap = p.obj ? undefined : [...(pageApps.get(p.name) ?? [])];
    const at = [`page:${p.name}`];
    for (const fl of p.flows) direct('flow', fl, 'page', p.obj, p.name, p.label, at, ap);
    for (const l of p.lwcs) direct('lwc', l, 'page', p.obj, p.name, p.label, at, ap);
  }

  // tabs: LWC/Aura tabs, reachable through the apps that list them
  for (const [tab, t] of tabInfo) {
    const ap = appTabs.get(tab) ?? [];
    direct('lwc', t.lwc, 'tab', null, tab, t.label, [], ap);
    direct('aura', t.aura, 'tab', null, tab, t.label, [], ap);
  }

  // custom buttons and links on objects
  const objDir = sub('objects');
  let buttons = 0;
  for (const o of fs.existsSync(objDir) ? fs.readdirSync(objDir) : []) {
    const wd = path.join(objDir, o, 'webLinks');
    if (!fs.existsSync(wd)) continue;
    for (const f of fs.readdirSync(wd).filter((x) => x.endsWith('.webLink-meta.xml'))) {
      buttons++;
      const name = baseName(f, '.webLink-meta.xml');
      const x = parser.parse(raw(path.join(wd, f))).WebLink ?? {};
      const url = text(x.url) ?? '';
      const at = layouts.filter((l) => l.obj === o && l.buttons.has(name)).map((l) => `layout:${l.name}`);
      const flow = url.match(/\/flow\/(?:[A-Za-z0-9_]+\/)?([A-Za-z0-9_]+)/) ?? url.match(/flowName=([A-Za-z0-9_]+)/);
      if (flow) direct('flow', flow[1], 'button', o, name, text(x.masterLabel) ?? text(x.label), at);
      const cmp = url.match(/lightning\/cmp\/c__([A-Za-z0-9_]+)/);
      if (cmp) direct(lwcSet.has(cmp[1]!) ? 'lwc' : 'aura', cmp[1], 'button', o, name, text(x.masterLabel) ?? text(x.label), at);
    }
  }

  // Visualforce pages embedding a flow (the standard controller gives the object)
  for (const f of files('pages', '.page')) {
    const src = raw(path.join(sub('pages'), f));
    const name = baseName(f, '.page');
    const obj = src.match(/standardController\s*=\s*["']([A-Za-z0-9_]+)["']/)?.[1] ?? null;
    for (const m of src.matchAll(/<flow:interview[^>]*\sname\s*=\s*["']([A-Za-z0-9_]+)["']/g)) direct('flow', m[1], 'vf', obj, name, undefined, []);
  }

  // ---- containers: where the target is embedded in something else that has its own routes
  const edges = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };
  for (const [fl, subs] of flowSubflows) for (const s of subs) if (screenFlows.has(fl)) link(`flow:${fl}`, `flow:${s}`);
  for (const [fl, ls] of flowLwcs) for (const l of ls) link(`flow:${fl}`, `lwc:${l}`);
  for (const [l, html] of lwcHtml) {
    for (const m of html.matchAll(/<c-([a-z0-9_-]+)/g)) if (kebabToCamel(m[1]!) !== l) link(`lwc:${l}`, `lwc:${kebabToCamel(m[1]!)}`);
    for (const m of html.matchAll(/flow-api-name\s*=\s*["']([A-Za-z0-9_]+)["']/g)) link(`lwc:${l}`, `flow:${m[1]}`);
    for (const m of (lwcJs.get(l) ?? '').matchAll(/flowApiName\s*[=:]\s*["']([A-Za-z0-9_]+)["']/g)) link(`lwc:${l}`, `flow:${m[1]}`);
  }
  for (const a of auraSet) {
    const src = [`${a}.cmp`, `${a}Controller.js`, `${a}Helper.js`].map((f) => raw(path.join(sub('aura'), a, f))).join('\n');
    for (const m of src.matchAll(/<c:([A-Za-z0-9_]+)/g)) link(`aura:${a}`, lwcSet.has(m[1]!) ? `lwc:${m[1]}` : `aura:${m[1]}`);
    for (const m of src.matchAll(/(?:flowApiName\s*=\s*["']|startFlow\(\s*["'])([A-Za-z0-9_]+)/g)) link(`aura:${a}`, `flow:${m[1]}`);
  }
  const label = (key: string) => (key.startsWith('flow:') ? 'flow' : key.startsWith('lwc:') ? 'LWC' : 'Aura component') + ' ' + key.slice(key.indexOf(':') + 1);
  for (let round = 0; round < INHERIT_ROUNDS; round++) {
    let changed = false;
    for (const [container, targets] of edges) {
      for (const r of [...(byTarget.get(container) ?? [])]) {
        for (const tk of targets) {
          const [t, x] = [tk.slice(0, tk.indexOf(':')) as Route['t'], tk.slice(tk.indexOf(':') + 1)];
          const up = `inside ${label(container)}${r.up ? `, ${r.up}` : ''}`;
          if (add({ ...r, t, x, up })) changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // ---- weak signal for LWCs that nothing routes to: objects they declare support for or read through the schema
  let inferred = 0;
  for (const l of lwcs) {
    if (byTarget.has(`lwc:${l.n}`)) continue;
    const objs = [...new Set([...(lwcDeclared.get(l.n) ?? []).map((o) => [o, `Declares support for ${o}`] as const), ...l.schema.map((o) => [o, `Imports ${o} schema`] as const)])].slice(0, 8);
    for (const [o, why] of objs) if (add({ t: 'lwc', x: l.n, k: 'inferred', o, n: why, at: [] })) inferred++;
  }

  const routes = [...byTarget.values()].flat();
  const stats: Record<string, number> = { quickActions, buttons, pages: pages.length, tabs: tabInfo.size, apps: files('applications', '.app-meta.xml').length, screenFlows: screenFlows.size, lwcs: lwcs.length, routes: routes.length, inferred };
  for (const r of routes) stats[`route:${r.k}`] = (stats[`route:${r.k}`] ?? 0) + 1;
  return { routes, lwcs, stats };
}
