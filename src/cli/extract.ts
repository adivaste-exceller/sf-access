import fs from 'node:fs';
import path from 'node:path';
import { SfClient, resolveOrg } from './client.js';
import { bodyIsTest } from '../shared/apex.js';
import {
  FLD, OBJ, SNAPSHOT_FILES, TRG,
  type Assignment, type FlowInfo, type TriggerInfo, type ObjectInfo, type PermSet, type PermSetGroup, type PsType, type Role, type SetupEntity, type SfUser, type Snapshot,
} from '../shared/types.js';

export interface ExtractOptions {
  org: string;
  out: string;
  fields: boolean;
  includePortal: boolean;
  detectTests: boolean;
  concurrency: number;
}

const log = (msg: string) => process.stderr.write(`${msg}\n`);

/** Run an optional step: a failure becomes a warning, not a crash. */
async function optional<T>(warnings: string[], label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = `${label} skipped: ${(e as Error).message.split('\n')[0]}`;
    warnings.push(msg);
    log(`  ! ${msg}`);
    return fallback;
  }
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const r = await fn();
  log(`  ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  return r;
}

const bool = (v: unknown) => v === true;

function objMask(r: any): number {
  return (
    (bool(r.PermissionsRead) ? OBJ.R : 0) | (bool(r.PermissionsCreate) ? OBJ.C : 0) | (bool(r.PermissionsEdit) ? OBJ.E : 0) |
    (bool(r.PermissionsDelete) ? OBJ.D : 0) | (bool(r.PermissionsViewAllRecords) ? OBJ.VA : 0) | (bool(r.PermissionsModifyAllRecords) ? OBJ.MA : 0)
  );
}

/** Group rows into a record keyed by parent id. */
function groupBy<T, V>(rows: T[], key: (r: T) => string, val: (r: T) => V): Record<string, V[]> {
  const out: Record<string, V[]> = {};
  for (const r of rows) (out[key(r)] ??= []).push(val(r));
  return out;
}

export async function extract(opts: ExtractOptions): Promise<void> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const org = await resolveOrg(opts.org);
  const c = new SfClient(org, opts.concurrency);
  log(`Extracting from ${org.alias} (${org.instanceUrl}), API v${org.apiVersion}${opts.includePortal ? ' [including portal users]' : ''}`);

  const userTypeFilter = opts.includePortal ? '' : " AND UserType = 'Standard'";
  const assigneeFilter = opts.includePortal ? '' : " AND Assignee.UserType = 'Standard'";

  // ---- Phase 1: independent bulk reads, all in parallel ----------------------------------------------------------
  log('Phase 1: principals, users, assignments');
  const durableToApi = new Map<string, string>();
  const [psRows, groupRows, compRows, mutingRows, userRows, assignRows, roleRows, entityRows] = await Promise.all([
    timed('permission sets', async () => {
      // Permission columns come from describe so this works across API versions. There are 600+ of them and the
      // query travels in the URL, so they are read in slices and merged by Id (one big query hits HTTP 431).
      const d = await c.describe('PermissionSet');
      const cols = d.fields.map((f) => f.name).filter((n) => n.startsWith('Permissions'));
      const SLICE = 80;
      const slices: string[][] = [];
      for (let i = 0; i < cols.length; i += SLICE) slices.push(cols.slice(i, i + SLICE));
      const [base, ...extra] = await Promise.all([
        c.query(`SELECT Id, Name, Label, Type, IsOwnedByProfile, ProfileId, Profile.Name, Profile.UserType, PermissionSetGroupId, NamespacePrefix, Description FROM PermissionSet WHERE Type != 'Session'`),
        ...slices.map((s) => c.query(`SELECT Id, ${s.join(', ')} FROM PermissionSet WHERE Type != 'Session'`)),
      ]);
      const byId = new Map<string, any>(base.map((r: any) => [r.Id, r]));
      for (const part of extra) for (const r of part) Object.assign(byId.get(r.Id) ?? {}, r);
      return { rows: [...byId.values()], cols };
    }),
    timed('permission set groups', () => optional(warnings, 'Permission set groups', () => c.query('SELECT Id, DeveloperName, MasterLabel, Status, Description FROM PermissionSetGroup'), [] as any[])),
    timed('group components', () => optional(warnings, 'Group components', () => c.query('SELECT PermissionSetGroupId, PermissionSetId FROM PermissionSetGroupComponent'), [] as any[])),
    timed('muting permission sets', () => optional(warnings, 'Muting permission sets', () => c.query('SELECT Id FROM MutingPermissionSet'), [] as any[])),
    timed('users', () =>
      c.query(`SELECT Id, Name, Username, Email, ProfileId, Profile.Name, UserRoleId, LastLoginDate, UserType FROM User WHERE IsActive = true${userTypeFilter}`),
    ),
    timed('assignments', () =>
      c.query(`SELECT AssigneeId, PermissionSetId, PermissionSetGroupId, ExpirationDate FROM PermissionSetAssignment WHERE Assignee.IsActive = true${assigneeFilter}`),
    ),
    timed('roles', () => optional(warnings, 'Roles', () => c.query("SELECT Id, Name, ParentRoleId FROM UserRole WHERE PortalType = 'None'"), [] as any[])),
    timed('object defaults', () => optional(warnings, 'Org-wide defaults', () => fetchEntityDefinitions(c, durableToApi), [] as ObjectInfo[])),
  ]);

  // Permission sets: drop portal/guest/system profiles unless asked for.
  const permSets: PermSet[] = [];
  const keepIds = new Set<string>();
  for (const r of psRows.rows) {
    if (r.IsOwnedByProfile && !opts.includePortal && r.Profile?.UserType !== 'Standard') continue;
    const type: PsType = r.IsOwnedByProfile ? 'Profile' : r.PermissionSetGroupId ? 'Group' : r.Type === 'Standard' ? 'Standard' : 'Regular';
    keepIds.add(r.Id);
    permSets.push({
      id: r.Id,
      name: r.Name,
      label: r.IsOwnedByProfile ? (r.Profile?.Name ?? r.Label) : r.Label,
      type,
      profile: r.IsOwnedByProfile ? r.Profile?.Name : undefined,
      groupId: r.PermissionSetGroupId ?? undefined,
      ns: r.NamespacePrefix ?? undefined,
      desc: r.Description ?? undefined,
      sys: psRows.cols.filter((k) => r[k] === true).map((k) => k.slice('Permissions'.length)),
    });
  }
  permSets.sort((a, b) => a.label.localeCompare(b.label));
  const psIndex = new Map(permSets.map((p, i) => [p.id, i]));
  const profileToPs = new Map(permSets.filter((p) => p.type === 'Profile').map((p) => [psRows.rows.find((r) => r.Id === p.id)!.ProfileId as string, psIndex.get(p.id)!]));

  const mutingIds = new Set<string>(mutingRows.map((m: any) => m.Id));
  const groupPs = new Map(permSets.filter((p) => p.type === 'Group').map((p) => [p.groupId!, p.id]));
  const compsByGroup = groupBy(compRows, (r: any) => r.PermissionSetGroupId, (r: any) => ({ psId: r.PermissionSetId as string, muting: mutingIds.has(r.PermissionSetId) }));
  const groups: PermSetGroup[] = groupRows
    .filter((g: any) => groupPs.has(g.Id))
    .map((g: any) => ({
      id: g.Id, name: g.DeveloperName, label: g.MasterLabel, status: g.Status, desc: g.Description ?? undefined,
      psId: groupPs.get(g.Id)!, components: compsByGroup[g.Id] ?? [],
    }))
    .sort((a: PermSetGroup, b: PermSetGroup) => a.label.localeCompare(b.label));

  // Users and assignments.
  const users: SfUser[] = userRows.map((u: any) => ({
    id: u.Id, name: u.Name, username: u.Username, email: u.Email, profile: profileToPs.get(u.ProfileId) ?? -1, profileName: u.Profile?.Name ?? '',
    roleId: u.UserRoleId ?? null, lastLogin: u.LastLoginDate ?? null, userType: u.UserType,
  }));
  users.sort((a, b) => a.name.localeCompare(b.name));
  const userIndex = new Map(users.map((u, i) => [u.id, i]));
  // Profile rows are implicit via user.profile. Rows carrying a PermissionSetGroupId on a non-group permission set
  // are derived from a group assignment, so only the group's own row is kept.
  const assignments: Assignment[] = [];
  for (const a of assignRows) {
    const ui = userIndex.get(a.AssigneeId);
    const pi = psIndex.get(a.PermissionSetId);
    if (ui === undefined || pi === undefined) continue;
    const ps = permSets[pi]!;
    if (ps.type === 'Profile') continue;
    if (a.PermissionSetGroupId && ps.type !== 'Group') continue;
    assignments.push([ui, pi, a.ExpirationDate ?? null]);
  }

  const roles: Role[] = roleRows.map((r: any) => ({ id: r.Id, name: r.Name, parent: r.ParentRoleId ?? null }));

  // ---- Phase 2: grants, chunked by parent id ---------------------------------------------------------------------
  // Group permission sets hold no rows of their own. Muting sets are not in PermissionSet but own ObjectPermissions rows.
  const normalIds = permSets.filter((p) => p.type !== 'Group').map((p) => p.id);
  const mutingList = [...mutingIds];
  log(`Phase 2: grants for ${normalIds.length} permission sets/profiles${mutingList.length ? ` + ${mutingList.length} muting sets` : ''}`);
  const progress = (label: string) => (d: number, t: number) => {
    if (d === t || d % 10 === 0) log(`    ${label} ${d}/${t} chunks`);
  };

  const objSelect = 'SELECT ParentId, SobjectType, PermissionsCreate, PermissionsRead, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions';
  const [objRows, objMutingRows, setupRows, tabRows] = await Promise.all([
    timed('object permissions', () => c.queryIn(normalIds, 25, (l) => `${objSelect} WHERE ParentId IN (${l}) AND PermissionsRead = true`, false, progress('objects'))),
    mutingList.length ? timed('object permissions (muting)', () => c.queryIn(mutingList, 25, (l) => `${objSelect} WHERE ParentId IN (${l})`)) : Promise.resolve([] as any[]),
    timed('setup entity access', () =>
      c.queryIn([...normalIds, ...mutingList], 25, (l) => `SELECT ParentId, SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId IN (${l})`, false, progress('setup')),
    ),
    timed('tab settings', () =>
      optional(warnings, 'Tab settings', () => c.queryIn([...normalIds, ...mutingList], 25, (l) => `SELECT ParentId, Name, Visibility FROM PermissionSetTabSetting WHERE ParentId IN (${l}) AND Visibility != 'None'`), [] as any[]),
    ),
  ]);

  const objectPerms = groupBy([...objRows, ...objMutingRows], (r: any) => r.ParentId, (r: any) => [r.SobjectType as string, objMask(r)] as [string, number]);
  const tabs = groupBy(tabRows, (r: any) => r.ParentId, (r: any) => [r.Name as string, r.Visibility === 'DefaultOn' ? 1 : 0] as [string, number]);

  const setupByType = new Map<string, Set<string>>();
  const setupTypeOf = new Map<string, string>();
  const setupAccess = groupBy(setupRows, (r: any) => r.ParentId, (r: any) => {
    setupTypeOf.set(r.SetupEntityId, r.SetupEntityType);
    let s = setupByType.get(r.SetupEntityType);
    if (!s) setupByType.set(r.SetupEntityType, (s = new Set()));
    s.add(r.SetupEntityId);
    return r.SetupEntityId as string;
  });

  // Field permissions are large and rarely needed, so they are opt-in.
  let fieldPerms: Snapshot['fieldPerms'] = {};
  if (opts.fields) {
    log('Phase 2b: field permissions (this can take a while)');
    const fldSelect = 'SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions';
    const [normal, muted] = await Promise.all([
      timed('field permissions', () => c.queryIn(normalIds, 5, (l) => `${fldSelect} WHERE ParentId IN (${l}) AND PermissionsRead = true`, false, progress('fields'))),
      mutingList.length ? c.queryIn(mutingList, 5, (l) => `${fldSelect} WHERE ParentId IN (${l})`) : Promise.resolve([] as any[]),
    ]);
    fieldPerms = groupBy([...normal, ...muted], (r: any) => r.ParentId, (r: any) => [r.Field as string, (r.PermissionsRead ? FLD.R : 0) | (r.PermissionsEdit ? FLD.E : 0)] as [string, number]);
  }

  // ---- Phase 3: names for setup entities (only for ids that are actually referenced) -----------------------------
  log('Phase 3: resolving setup entity names');
  const setupEntities: Record<string, SetupEntity> = {};
  const resolveInto = async (type: string, label: string, soql: string, map: (r: any) => [string, string, string?], tooling = false) => {
    if (!setupByType.has(type)) return;
    const rows = await optional(warnings, label, () => c.query(soql, tooling), [] as any[]);
    for (const r of rows) {
      const [id, n, l] = map(r);
      if (setupByType.get(type)!.has(id)) setupEntities[id] = { t: type, n, l };
    }
  };
  await Promise.all([
    resolveInto('ApexClass', 'Apex class names', 'SELECT Id, Name, NamespacePrefix FROM ApexClass', (r) => [r.Id, r.NamespacePrefix ? `${r.NamespacePrefix}.${r.Name}` : r.Name]),
    resolveInto('ApexPage', 'Visualforce page names', 'SELECT Id, Name, NamespacePrefix FROM ApexPage', (r) => [r.Id, r.NamespacePrefix ? `${r.NamespacePrefix}.${r.Name}` : r.Name]),
    resolveInto('CustomPermission', 'Custom permission names', 'SELECT Id, DeveloperName, MasterLabel FROM CustomPermission', (r) => [r.Id, r.DeveloperName, r.MasterLabel]),
    resolveInto('FlowDefinition', 'Flow names', 'SELECT DurableId, ApiName, Label FROM FlowDefinitionView', (r) => [r.DurableId, r.ApiName, r.Label]),
    resolveInto('TabSet', 'App names', "SELECT ApplicationId, Name, Label FROM AppMenuItem WHERE Type = 'TabSet'", (r) => [r.ApplicationId, r.Name, r.Label]),
    resolveInto('ConnectedApplication', 'Connected app names', 'SELECT Id, Name FROM ConnectedApplication', (r) => [r.Id, r.Name]),
    resolveInto('ExternalDataSource', 'External data source names', 'SELECT Id, DeveloperName, MasterLabel FROM ExternalDataSource', (r) => [r.Id, r.DeveloperName, r.MasterLabel]),
    resolveInto('ExternalClientApplication', 'External client app names', 'SELECT Id, DeveloperName, MasterLabel FROM ExternalClientApplication', (r) => [r.Id, r.DeveloperName, r.MasterLabel]),
    // Custom settings / custom metadata types granted through setup entity access.
    resolveInto('CustomEntityDefinition', 'Custom entity names', 'SELECT Id, DeveloperName, NamespacePrefix FROM CustomObject', (r) => [r.Id, r.NamespacePrefix ? `${r.NamespacePrefix}__${r.DeveloperName}` : `${r.DeveloperName}__c`], true),
  ]);
  // Anything unresolved keeps its id so it still shows up.
  for (const [id, t] of setupTypeOf) setupEntities[id] ??= { t, n: id };

  // ---- Phase 3c: automation. Triggers and flows are not granted to anyone; the UI links them to principals through
  // object access, so only metadata (no bodies) is read here.
  log('Phase 3c: triggers and flows');
  const triggers = await timed('triggers', () =>
    optional(warnings, 'Apex triggers', async () => {
      const rows = await c.query(
        'SELECT Name, TableEnumOrId, Status, NamespacePrefix, UsageBeforeInsert, UsageAfterInsert, UsageBeforeUpdate, UsageAfterUpdate, UsageBeforeDelete, UsageAfterDelete, UsageAfterUndelete FROM ApexTrigger',
      );
      return rows
        .filter((r: any) => r.Status !== 'Deleted')
        .map((r: any): TriggerInfo => ({
          n: r.Name,
          // REST returns the API name; a 01I id (older orgs / tooling) is mapped back through the object list.
          o: durableToApi.get(r.TableEnumOrId) ?? r.TableEnumOrId,
          ev: (r.UsageBeforeInsert ? TRG.BI : 0) | (r.UsageAfterInsert ? TRG.AI : 0) | (r.UsageBeforeUpdate ? TRG.BU : 0) | (r.UsageAfterUpdate ? TRG.AU : 0) |
            (r.UsageBeforeDelete ? TRG.BD : 0) | (r.UsageAfterDelete ? TRG.AD : 0) | (r.UsageAfterUndelete ? TRG.UD : 0),
          a: r.Status === 'Active',
          ns: r.NamespacePrefix ?? undefined,
        }));
    }, [] as TriggerInfo[]),
  );
  const flows = await timed('flows', () =>
    optional(warnings, 'Flows', async () => {
      const rows = await c.query(
        'SELECT DurableId, ApiName, Label, ProcessType, TriggerType, RecordTriggerType, IsActive, TriggerObjectOrEventId, ManageableState FROM FlowDefinitionView',
      );
      return rows.map((r: any): FlowInfo => ({
        id: r.DurableId, n: r.ApiName, l: r.Label, pt: r.ProcessType, tt: r.TriggerType ?? undefined, rt: r.RecordTriggerType ?? undefined,
        o: r.TriggerObjectOrEventId ? (durableToApi.get(r.TriggerObjectOrEventId) ?? r.TriggerObjectOrEventId) : undefined,
        a: r.IsActive === true, inst: r.ManageableState === 'installed' ? true : undefined,
      }));
    }, [] as FlowInfo[]),
  );

  // Opt-in: read class bodies to flag test classes exactly. Body cannot be filtered in SOQL, so the bodies of the
  // referenced unmanaged classes are fetched in small batches and checked here. Managed-package bodies are hidden.
  let testDetection: 'body' | undefined;
  if (opts.detectTests) {
    const classIds = Object.entries(setupEntities).filter(([, e]) => e.t === 'ApexClass' && !e.n.includes('.')).map(([id]) => id);
    log(`Phase 3b: reading ${classIds.length} class bodies to find test classes`);
    const ok = await timed('class bodies', () =>
      optional(warnings, 'Test class detection', async () => {
        const rows = await c.queryIn(classIds, 100, (l) => `SELECT Id, Body FROM ApexClass WHERE Id IN (${l})`, false, progress('classes'));
        for (const r of rows) if (bodyIsTest(r.Body)) setupEntities[r.Id]!.test = true;
        return true;
      }, false),
    );
    if (ok) testDetection = 'body';
  }

  // ---- Write ------------------------------------------------------------------------------------------------------
  const snapshot: Snapshot = {
    meta: {
      version: 1, alias: org.alias, username: org.username, instanceUrl: org.instanceUrl, apiVersion: org.apiVersion,
      extractedAt: new Date().toISOString(), includePortal: opts.includePortal, hasFields: opts.fields, testDetection, warnings,
      counts: {
        profiles: permSets.filter((p) => p.type === 'Profile').length,
        permissionSets: permSets.filter((p) => p.type === 'Regular' || p.type === 'Standard').length,
        groups: groups.length, users: users.length, assignments: assignments.length, roles: roles.length, mutingSets: mutingIds.size,
        triggers: triggers.length, flows: flows.length,
        objectGrants: objRows.length, setupGrants: setupRows.length, tabGrants: tabRows.length,
        fieldGrants: Object.values(fieldPerms).reduce((n, a) => n + a.length, 0), apiRequests: c.requests,
      },
    },
    permissionSets: permSets, groups, users, assignments, objectPerms, fieldPerms, setupAccess, setupEntities, tabs, objects: entityRows, roles, triggers, flows,
  };
  fs.mkdirSync(opts.out, { recursive: true });
  for (const key of SNAPSHOT_FILES) fs.writeFileSync(path.join(opts.out, `${key}.json`), JSON.stringify(snapshot[key]));
  log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${c.requests} API requests -> ${path.resolve(opts.out)}`);
  log(JSON.stringify(snapshot.meta.counts));
  if (warnings.length) log(`${warnings.length} warning(s), see meta.json`);
}

/** EntityDefinition does not support queryMore, so page by QualifiedApiName. */
async function fetchEntityDefinitions(c: SfClient, durableToApi: Map<string, string>): Promise<ObjectInfo[]> {
  const out: ObjectInfo[] = [];
  let last = '';
  for (;;) {
    const rows = await c.query(
      `SELECT QualifiedApiName, DurableId, Label, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName > '${last}' AND IsCustomizable = true ORDER BY QualifiedApiName LIMIT 2000`,
    );
    for (const r of rows) {
      out.push({ n: r.QualifiedApiName, l: r.Label, owd: r.InternalSharingModel ?? undefined, ext: r.ExternalSharingModel ?? undefined });
      // Custom objects are identified by their 01I id in flow metadata; standard ones by API name.
      if (r.DurableId) durableToApi.set(r.DurableId, r.QualifiedApiName);
    }
    if (rows.length < 2000) return out;
    last = rows[rows.length - 1].QualifiedApiName;
  }
}
