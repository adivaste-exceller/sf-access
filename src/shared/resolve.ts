import { OBJ, TRG, type FlowInfo, type LwcInfo, type PermSet, type PermSetGroup, type Route, type RouteKind, type Snapshot, type SfUser } from './types.js';

export type PrincipalKind = 'profile' | 'permset' | 'group' | 'user';

export interface Principal {
  kind: PrincipalKind;
  /** Profile / permission set / group: the PermissionSet id. User: the User id. */
  id: string;
  label: string;
}

export interface Grant {
  mask: number;
  /** Human readable paths that explain the grant, e.g. `PSG "Sales" → PS "Base"`. */
  via: string[];
}

export interface Effective {
  objects: Map<string, Grant>;
  fields: Map<string, Grant>;
  setup: Map<string, { via: string[] }>;
  tabs: Map<string, Grant>;
  system: Map<string, { via: string[] }>;
}

/** What a muting permission set takes away: the same shape as a grant, but every set bit is removed. */
interface Mute {
  objects: Map<string, number>;
  fields: Map<string, number>;
  setup: Set<string>;
  tabs: Set<string>;
}

/** A trigger or flow that fires on DML the selection can perform. */
export interface AutomationRow {
  key: string;
  name: string;
  /** API name. */
  sub: string;
  /** Short description of what fires, e.g. "Lead · before insert, after update". */
  extra: string;
  via: string[];
}

/** How a flow or component is reached: a route kind, or "nested" when it sits inside another component or flow. */
export type TraceKind = RouteKind | 'nested';

/** A screen flow, LWC or Aura component a selection can reach, grouped under the object it is reached from. */
export interface TraceRow {
  key: string;
  /** Best way in. */
  kind: TraceKind;
  /** Every kind of way in, for filtering. */
  kinds: TraceKind[];
  /** Name of the best entry point (or the container, for nested rows). */
  entry: string;
  /** Number of further routes beyond the best one. */
  more: number;
  /** Group heading: the object, or "No object". */
  group: string;
  /** Object API name behind the group, null for the no-object group. */
  object: string | null;
  name: string;
  sub: string;
  /** First way in, plus how many more. */
  extra: string;
  /** Every way in, with where it is placed and what access it relies on. */
  via: string[];
  /** Something the selection is missing for this to work (flow access, Apex access). */
  warn?: string;
}

export const NO_OBJECT_GROUP = 'No object (global actions, apps, utility bar)';

const ROUTE_LABEL: Record<string, string> = {
  quickAction: 'Quick action',
  button: 'Custom button',
  page: 'Lightning page',
  tab: 'Tab',
  vf: 'Visualforce page',
  aura: 'Aura component',
  lwc: 'LWC',
  flow: 'Flow',
  inferred: 'Inferred',
};

/** Plain-language flow category for labels. */
export function flowKind(f: Pick<FlowInfo, 'pt' | 'tt'>): string {
  if (f.tt === 'RecordBeforeSave' || f.tt === 'RecordAfterSave') return 'Record-triggered';
  if (f.tt === 'Scheduled') return 'Scheduled';
  if (f.tt === 'PlatformEvent') return 'Platform event';
  if (f.pt === 'Flow') return 'Screen flow';
  if (f.pt === 'AutoLaunchedFlow') return 'Autolaunched';
  return f.pt;
}

const MAX_VIA = 12;

function addVia(list: string[], via: string): void {
  if (list.length < MAX_VIA && !list.includes(via)) list.push(via);
}

function mergeMask(map: Map<string, Grant>, key: string, mask: number, via: string): void {
  const g = map.get(key);
  if (g) {
    g.mask |= mask;
    addVia(g.via, via);
  } else map.set(key, { mask, via: [via] });
}

function mergeFlag(map: Map<string, { via: string[] }>, key: string, via: string): void {
  const g = map.get(key);
  if (g) addVia(g.via, via);
  else map.set(key, { via: [via] });
}

export class Index {
  readonly psById = new Map<string, PermSet>();
  readonly groupByPsId = new Map<string, PermSetGroup>();
  readonly userById = new Map<string, SfUser>();
  /** user index -> permission set indexes (non-profile). */
  readonly assignmentsByUser = new Map<number, { ps: number; expires: string | null }[]>();
  /** psId -> user indexes that hold it (profiles, permission sets and groups). */
  readonly holders = new Map<string, number[]>();

  constructor(readonly s: Snapshot) {
    for (const p of s.permissionSets) this.psById.set(p.id, p);
    for (const g of s.groups) this.groupByPsId.set(g.psId, g);
    s.users.forEach((u, i) => {
      this.userById.set(u.id, u);
      const prof = s.permissionSets[u.profile];
      if (prof) this.hold(prof.id, i);
    });
    for (const [ui, pi, exp] of s.assignments) {
      const list = this.assignmentsByUser.get(ui) ?? [];
      list.push({ ps: pi, expires: exp });
      this.assignmentsByUser.set(ui, list);
      const ps = s.permissionSets[pi];
      if (ps) this.hold(ps.id, ui);
    }
  }

  private hold(psId: string, userIdx: number): void {
    const l = this.holders.get(psId);
    if (l) l.push(userIdx);
    else this.holders.set(psId, [userIdx]);
  }

  holderCount(psId: string): number {
    return this.holders.get(psId)?.length ?? 0;
  }

  private muteOf(g: PermSetGroup): Mute | undefined {
    const muting = g.components.filter((c) => c.muting);
    if (!muting.length) return undefined;
    const m: Mute = { objects: new Map(), fields: new Map(), setup: new Set(), tabs: new Set() };
    for (const { psId } of muting) {
      for (const [k, v] of this.s.objectPerms[psId] ?? []) m.objects.set(k, (m.objects.get(k) ?? 0) | v);
      for (const [k, v] of this.s.fieldPerms[psId] ?? []) m.fields.set(k, (m.fields.get(k) ?? 0) | v);
      for (const id of this.s.setupAccess[psId] ?? []) m.setup.add(id);
      for (const [k] of this.s.tabs[psId] ?? []) m.tabs.add(k);
    }
    return m;
  }

  private addPs(acc: Effective, psId: string, via: string, mute?: Mute): void {
    const ps = this.psById.get(psId);
    if (!ps) return;
    for (const [obj, mask] of this.s.objectPerms[psId] ?? []) {
      const m = mute ? mask & ~(mute.objects.get(obj) ?? 0) : mask;
      if (m) mergeMask(acc.objects, obj, m, via);
    }
    for (const [fld, mask] of this.s.fieldPerms[psId] ?? []) {
      const m = mute ? mask & ~(mute.fields.get(fld) ?? 0) : mask;
      if (m) mergeMask(acc.fields, fld, m, via);
    }
    for (const id of this.s.setupAccess[psId] ?? []) if (!mute?.setup.has(id)) mergeFlag(acc.setup, id, via);
    for (const [name, on] of this.s.tabs[psId] ?? []) if (!mute?.tabs.has(name)) mergeMask(acc.tabs, name, on ? 2 : 1, via);
    for (const name of ps.sys) mergeFlag(acc.system, name, via);
  }

  private addGroup(acc: Effective, g: PermSetGroup, prefix: string): void {
    const mute = this.muteOf(g);
    for (const comp of g.components) {
      if (comp.muting) continue;
      const ps = this.psById.get(comp.psId);
      if (ps) this.addPs(acc, comp.psId, `${prefix}Group "${g.label}" → ${ps.label}`, mute);
    }
  }

  /**
   * Triggers and record-triggered flows that fire on DML the selection can perform, derived from its object access:
   * insert needs Create, update needs Edit, delete and undelete need Delete. Nothing here is granted; entry conditions
   * and trigger logic are not evaluated, so a row means "can fire", and the same code also fires for other users.
   */
  automation(eff: Effective, showInactive: boolean): { triggers: AutomationRow[]; flows: AutomationRow[] } {
    // Modify All Data is full access to every object, with or without explicit object rows.
    const modifyAll = eff.system.get('ModifyAllData');
    const FULL = OBJ.R | OBJ.C | OBJ.E | OBJ.D | OBJ.VA | OBJ.MA;
    const access = (obj: string): { mask: number; via: string[]; mad: string[] } | undefined => {
      const g = eff.objects.get(obj);
      if (!g && !modifyAll) return undefined;
      return { mask: (g?.mask ?? 0) | (modifyAll ? FULL : 0), via: g?.via ?? [], mad: modifyAll?.via ?? [] };
    };
    const needLine = (perm: string, obj: string, g: { via: string[]; mad: string[] }) => [
      `Needs ${perm} on ${obj}`,
      ...g.via.map((v) => `${perm} on ${obj} from ${v}`),
      ...g.mad.map((v) => `Modify All Data (system permission) from ${v}`),
    ];

    const triggers: AutomationRow[] = [];
    for (const t of this.s.triggers ?? []) {
      if (!t.a && !showInactive) continue;
      const g = access(t.o);
      if (!g) continue;
      const fired: string[] = [];
      const perms: string[] = [];
      if (g.mask & OBJ.C) {
        if (t.ev & TRG.BI) fired.push('before insert');
        if (t.ev & TRG.AI) fired.push('after insert');
        if (t.ev & (TRG.BI | TRG.AI)) perms.push('Create');
      }
      if (g.mask & OBJ.E) {
        if (t.ev & TRG.BU) fired.push('before update');
        if (t.ev & TRG.AU) fired.push('after update');
        if (t.ev & (TRG.BU | TRG.AU)) perms.push('Edit');
      }
      if (g.mask & OBJ.D) {
        if (t.ev & TRG.BD) fired.push('before delete');
        if (t.ev & TRG.AD) fired.push('after delete');
        if (t.ev & TRG.UD) fired.push('after undelete');
        if (t.ev & (TRG.BD | TRG.AD | TRG.UD)) perms.push('Delete');
      }
      if (!fired.length) continue;
      triggers.push({
        key: `t:${t.o}:${t.n}`,
        name: t.n + (t.a ? '' : ' (inactive)'),
        sub: t.o,
        extra: `${t.o} · ${fired.join(', ')}`,
        via: needLine(perms.join(' + '), t.o, g),
      });
    }

    const flows: AutomationRow[] = [];
    for (const f of this.s.flows ?? []) {
      if ((f.tt !== 'RecordBeforeSave' && f.tt !== 'RecordAfterSave') || !f.o) continue;
      if (!f.a && !showInactive) continue;
      const g = access(f.o);
      if (!g) continue;
      const perms: string[] = [];
      if ((f.rt === 'Create' || f.rt === 'CreateAndUpdate') && g.mask & OBJ.C) perms.push('Create');
      if ((f.rt === 'Update' || f.rt === 'CreateAndUpdate') && g.mask & OBJ.E) perms.push('Edit');
      if (f.rt === 'Delete' && g.mask & OBJ.D) perms.push('Delete');
      if (!perms.length) continue;
      const when = f.rt === 'CreateAndUpdate' ? 'create or update' : (f.rt ?? '').toLowerCase();
      flows.push({
        key: `f:${f.id}`,
        name: (f.l || f.n) + (f.a ? '' : ' (inactive)'),
        sub: f.n,
        extra: `${f.o} · ${f.tt === 'RecordBeforeSave' ? 'before' : 'after'} save · ${when}${f.inst ? ' · installed' : ''}`,
        via: needLine(perms.join(' + '), f.o, g),
      });
    }
    return { triggers, flows };
  }

  private lookups?: { flowId: Map<string, string>; apexId: Map<string, string>; appId: Map<string, string>; flowLabel: Map<string, string>; lwcByName: Map<string, LwcInfo>; objLabel: Map<string, string> };

  private getLookups() {
    if (this.lookups) return this.lookups;
    const byType = (t: string) => new Map(Object.entries(this.s.setupEntities).filter(([, e]) => e.t === t).map(([id, e]) => [e.n, id] as const));
    this.lookups = {
      flowId: byType('FlowDefinition'),
      apexId: byType('ApexClass'),
      appId: byType('TabSet'),
      flowLabel: new Map((this.s.flows ?? []).map((f) => [f.n, f.l || f.n] as const)),
      lwcByName: new Map((this.s.lwcs ?? []).map((l) => [l.n, l] as const)),
      objLabel: new Map(this.s.objects.map((o) => [o.n, o.l] as const)),
    };
    return this.lookups;
  }

  /**
   * Screen flows and LWC/Aura components the selection can reach, grouped by the object they are reached from.
   * A route counts when the selection can read the entry point's object, or (for tabs and utility bars) has the app.
   * Needs a snapshot extracted with --metadata. Flow and Apex gaps are reported as warnings, not hidden.
   */
  traces(eff: Effective): { flows: TraceRow[]; lwcs: TraceRow[] } {
    const L = this.getLookups();
    const viewAll = eff.system.has('ModifyAllData') || eff.system.has('ViewAllData');
    const canRead = (obj: string) => viewAll || ((eff.objects.get(obj)?.mask ?? 0) & OBJ.R) !== 0;
    const hasApp = (app: string) => {
      const id = L.appId.get(app);
      return !!id && eff.setup.has(id);
    };
    const runFlows = eff.system.has('RunFlow');

    const groups = new Map<string, { group: string; t: string; x: string; routes: Route[] }>();
    for (const r of this.s.routes ?? []) {
      if (r.o) {
        if (!canRead(r.o)) continue;
      } else if (r.ap && r.ap.length && !r.ap.some(hasApp)) continue;
      const group = r.o ? `${L.objLabel.get(r.o) && L.objLabel.get(r.o) !== r.o ? `${L.objLabel.get(r.o)} · ` : ''}${r.o}` : NO_OBJECT_GROUP;
      const key = `${group}|${r.t}:${r.x}`;
      const g = groups.get(key) ?? { group, t: r.t, x: r.x, routes: [] };
      g.routes.push(r);
      groups.set(key, g);
    }

    const describe = (r: Route): string => {
      let s = r.k === 'inferred' ? r.n : `${ROUTE_LABEL[r.k] ?? r.k} "${r.l || r.n}"`;
      if (r.k === 'quickAction' || r.k === 'button') s += r.at.length ? ` · shown on ${r.at.slice(0, 3).join(', ')}${r.at.length > 3 ? ` +${r.at.length - 3}` : ''}` : ' · not placed on any layout or page we could read';
      else if (r.k === 'tab') s += r.ap && r.ap.length ? ` · in app ${r.ap.join(', ')}` : ' · not in any app';
      else if (r.k === 'page' && r.ap && r.ap.length) s += ` · in app ${r.ap.join(', ')}`;
      if (r.up) s += ` · ${r.up}`;
      return s;
    };

    const flows: TraceRow[] = [];
    const lwcs: TraceRow[] = [];
    for (const [key, g] of groups) {
      const first = g.routes[0]!;
      // Best way in: launched directly, else nested inside another component or flow, else only inferred.
      const lead = g.routes.find((r) => r.k !== 'inferred' && !r.up) ?? g.routes.find((r) => r.k !== 'inferred') ?? first;
      const more = g.routes.length - 1;
      const nestedIn = lead.up ? /^inside ([^,]+)/.exec(lead.up)?.[1] : undefined;
      const via = g.routes.slice(0, 12).map(describe);
      if (g.routes.length > 12) via.push(`+${g.routes.length - 12} more routes`);
      const classify = (r: Route): TraceKind => (r.k === 'inferred' ? 'inferred' : r.up ? 'nested' : r.k);
      const row: TraceRow = {
        key,
        kind: classify(lead),
        kinds: [...new Set(g.routes.map(classify))],
        entry: lead.k === 'inferred' ? lead.n : (nestedIn ?? (lead.l || lead.n)),
        more,
        group: g.group,
        object: first.o,
        name: g.x,
        sub: g.x,
        extra: `${lead.k === 'inferred' ? lead.n : nestedIn ? `nested in ${nestedIn}` : `${ROUTE_LABEL[lead.k] ?? lead.k} · ${lead.l || lead.n}`}${more > 0 ? ` +${more}` : ''}${lead.k !== 'inferred' && !nestedIn && (lead.k === 'quickAction' || lead.k === 'button') && !lead.at.length ? ' · not placed' : ''}`,
        via,
      };
      if (g.t === 'flow') {
        row.name = L.flowLabel.get(g.x) ?? g.x;
        const id = L.flowId.get(g.x);
        if (!runFlows && !(id && eff.setup.has(id))) row.warn = 'no Run Flows permission or flow access found';
        flows.push(row);
      } else {
        if (g.t === 'aura') row.sub = 'Aura component';
        else {
          const info = L.lwcByName.get(g.x);
          if (info?.l) row.name = info.l;
          const missing = (info?.apex ?? []).filter((c) => {
            const id = L.apexId.get(c);
            return id && !eff.setup.has(id);
          });
          if (missing.length) row.warn = `no access to Apex: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` +${missing.length - 3}` : ''}`;
        }
        lwcs.push(row);
      }
    }
    const order = (a: TraceRow, b: TraceRow) => (a.group === NO_OBJECT_GROUP ? 1 : 0) - (b.group === NO_OBJECT_GROUP ? 1 : 0) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name);
    return { flows: flows.sort(order), lwcs: lwcs.sort(order) };
  }

  /** Union of everything the given principals are directly granted. */
  effective(principals: Principal[]): Effective {
    const acc: Effective = { objects: new Map(), fields: new Map(), setup: new Map(), tabs: new Map(), system: new Map() };
    const multi = principals.length > 1;
    for (const p of principals) {
      const tag = multi ? `${p.label}: ` : '';
      if (p.kind === 'profile') this.addPs(acc, p.id, `${tag}Profile "${p.label}"`);
      else if (p.kind === 'permset') this.addPs(acc, p.id, `${tag}Permission set "${p.label}"`);
      else if (p.kind === 'group') {
        const g = this.groupByPsId.get(p.id);
        if (g) this.addGroup(acc, g, tag);
      } else {
        const u = this.userById.get(p.id);
        if (!u) continue;
        const prof = this.s.permissionSets[u.profile];
        if (prof) this.addPs(acc, prof.id, `${tag}Profile "${prof.label}"`);
        const ui = this.s.users.indexOf(u);
        for (const a of this.assignmentsByUser.get(ui) ?? []) {
          const ps = this.s.permissionSets[a.ps];
          if (!ps || (a.expires && Date.parse(a.expires) < Date.now())) continue;
          if (ps.type === 'Group') {
            const g = this.groupByPsId.get(ps.id);
            if (g) this.addGroup(acc, g, tag);
          } else this.addPs(acc, ps.id, `${tag}Permission set "${ps.label}"`);
        }
      }
    }
    return acc;
  }
}
