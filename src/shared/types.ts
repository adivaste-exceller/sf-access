// Snapshot format shared by the extractor (writes) and the UI (reads).
// Kept compact: permissions are bitmasks, rows are tuples, ids are strings only where unavoidable.

/** Object permission bits. */
export const OBJ = { R: 1, C: 2, E: 4, D: 8, VA: 16, MA: 32 } as const;
/** Field permission bits. */
export const FLD = { R: 1, E: 2 } as const;
/** Apex trigger event bits. */
export const TRG = { BI: 1, AI: 2, BU: 4, AU: 8, BD: 16, AD: 32, UD: 64 } as const;

export interface TriggerInfo {
  /** Trigger name. */
  n: string;
  /** Object API name. */
  o: string;
  /** TRG event bitmask. */
  ev: number;
  /** Active. */
  a: boolean;
  /** Namespace prefix, when it comes from a managed package. */
  ns?: string;
}

export interface FlowInfo {
  /** FlowDefinition id (matches SetupEntityAccess entity ids). */
  id: string;
  /** API name. */
  n: string;
  l: string;
  /** ProcessType, e.g. Flow (screen), AutoLaunchedFlow. */
  pt: string;
  /** TriggerType: RecordBeforeSave, RecordAfterSave, Scheduled, PlatformEvent, or absent. */
  tt?: string;
  /** RecordTriggerType: Create, Update, CreateAndUpdate, Delete. */
  rt?: string;
  /** Trigger object API name (record-triggered flows). */
  o?: string;
  a: boolean;
  /** Installed from a package. */
  inst?: boolean;
}

export interface SnapshotMeta {
  version: 1;
  alias: string;
  username: string;
  instanceUrl: string;
  apiVersion: string;
  extractedAt: string;
  includePortal: boolean;
  hasFields: boolean;
  /** 'body' when test classes were detected from class bodies (--detect-tests); absent means name-based guessing. */
  testDetection?: 'body';
  /** True when routes (flow and LWC entry points) were extracted with --metadata. */
  hasMetadata?: boolean;
  counts: Record<string, number>;
  warnings: string[];
}

export type PsType = 'Profile' | 'Regular' | 'Standard' | 'Group';

export interface PermSet {
  id: string;
  name: string;
  label: string;
  type: PsType;
  /** Profile name when type === 'Profile'. */
  profile?: string;
  /** PermissionSetGroup id when type === 'Group'. */
  groupId?: string;
  ns?: string;
  desc?: string;
  /** Names of system permissions (PermissionsXxx) that are true. */
  sys: string[];
}

export interface PermSetGroup {
  id: string;
  name: string;
  label: string;
  status: string;
  desc?: string;
  /** Id of the PermissionSet row that represents the group in assignments. */
  psId: string;
  components: { psId: string; muting: boolean }[];
}

export interface SfUser {
  id: string;
  name: string;
  username: string;
  email: string;
  /** Index into permissionSets of the user's profile (-1 if its profile was filtered out). */
  profile: number;
  profileName: string;
  roleId: string | null;
  lastLogin: string | null;
  userType: string;
}

/** [userIndex, permissionSetIndex, expirationDate]. Excludes profile rows and group-derived component rows. */
export type Assignment = [number, number, string | null];

export interface SetupEntity {
  /** SetupEntityType, e.g. ApexClass, ApexPage, FlowDefinition, TabSet, CustomPermission. */
  t: string;
  n: string;
  l?: string;
  /** Apex classes only, set by --detect-tests: the class is a test class. */
  test?: boolean;
}

export type RouteKind = 'quickAction' | 'button' | 'page' | 'tab' | 'vf' | 'aura' | 'lwc' | 'flow' | 'inferred';

/**
 * One way a user can reach a screen flow, LWC or Aura component: an entry point (quick action, custom button, Lightning
 * page, tab, ...) that leads to the target. Built from retrieved metadata, so it needs extract --metadata.
 */
export interface Route {
  /** Target type. */
  t: 'flow' | 'lwc' | 'aura';
  /** Target API name: flow API name, LWC folder name or Aura bundle name. */
  x: string;
  k: RouteKind;
  /** Object the entry point belongs to; null when it is not object-specific (global action, app page, utility bar). */
  o: string | null;
  /** Entry point name (quick action, button, page, tab or component). */
  n: string;
  l?: string;
  /** Layouts and pages where the entry point is placed ("layout:X", "page:Y"). Empty when none was found. */
  at: string[];
  /** Apps through which a non-object entry point (tab, utility bar) is reachable. */
  ap?: string[];
  /** Set when the route is inherited from a container, e.g. "inside LWC ex_createBooking". */
  up?: string;
}

export interface LwcInfo {
  n: string;
  l?: string;
  /** Declared targets, e.g. lightning__RecordPage. */
  targets: string[];
  /** Apex classes imported by the component. */
  apex: string[];
  /** Objects imported through @salesforce/schema. */
  schema: string[];
}

export interface ObjectInfo {
  n: string;
  l: string;
  /** Internal org-wide default. */
  owd?: string;
  /** External org-wide default. */
  ext?: string;
}

export interface Role {
  id: string;
  name: string;
  parent: string | null;
}

export interface Snapshot {
  meta: SnapshotMeta;
  permissionSets: PermSet[];
  groups: PermSetGroup[];
  users: SfUser[];
  assignments: Assignment[];
  /** psId -> [objectApiName, OBJ mask][] */
  objectPerms: Record<string, [string, number][]>;
  /** psId -> ["Object.Field", FLD mask][] (empty unless extracted with --fields). */
  fieldPerms: Record<string, [string, number][]>;
  /** psId -> setup entity ids. */
  setupAccess: Record<string, string[]>;
  setupEntities: Record<string, SetupEntity>;
  /** psId -> [tabName, 1 = default on | 0 = default off][] */
  tabs: Record<string, [string, number][]>;
  objects: ObjectInfo[];
  roles: Role[];
  /** Absent in snapshots made before triggers and flows were extracted. */
  triggers: TriggerInfo[];
  flows: FlowInfo[];
  /** Empty unless extracted with --metadata. */
  routes: Route[];
  lwcs: LwcInfo[];
}

/** Files that older snapshots may not have; the UI treats a missing one as empty. */
export const OPTIONAL_SNAPSHOT_FILES = ['triggers', 'flows', 'routes', 'lwcs'] as const;

export const SNAPSHOT_FILES = [
  'meta',
  'permissionSets',
  'groups',
  'users',
  'assignments',
  'objectPerms',
  'fieldPerms',
  'setupAccess',
  'setupEntities',
  'tabs',
  'objects',
  'roles',
  'triggers',
  'flows',
  'routes',
  'lwcs',
] as const;
