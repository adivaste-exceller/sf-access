import { XMLParser } from 'fast-xml-parser';
import type { SfClient } from './client.js';

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true, removeNSPrefix: true });
const arr = <T>(x: T | T[] | undefined | null): T[] => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

export interface TypeInfo {
  name: string;
  /** Folder types (Report, Dashboard, Document, EmailTemplate) are listed per folder. */
  inFolder: boolean;
  /** Child types are retrieved together with their parent (CustomField with CustomObject). */
  children: string[];
}

export interface Listed {
  fullName: string;
  /** Set for components that come from a managed or installed package. */
  namespace?: string;
}

/** Everything the org can retrieve at this API version. */
export async function describeTypes(c: SfClient): Promise<TypeInfo[]> {
  const xml = await c.soap(`<describeMetadata><asOfVersion>${c.org.apiVersion}</asOfVersion></describeMetadata>`);
  const r = parser.parse(xml)?.Envelope?.Body?.describeMetadataResponse?.result;
  return arr<any>(r?.metadataObjects).map((m) => ({ name: m.xmlName, inFolder: m.inFolder === 'true', children: arr<string>(m.childXmlNames) }));
}

/**
 * Enumerate the members of one type. Unlike a `*` wildcard in package.xml this includes standard objects, and it is
 * what lets us write explicit member names. Folder types are listed folder by folder.
 */
export async function listType(c: SfClient, type: string, folder?: string): Promise<Listed[]> {
  const q = `<queries><type>${type}</type>${folder ? `<folder>${folder.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</folder>` : ''}</queries>`;
  const xml = await c.soap(`<listMetadata>${q}<asOfVersion>${c.org.apiVersion}</asOfVersion></listMetadata>`);
  const resp = parser.parse(xml)?.Envelope?.Body?.listMetadataResponse;
  return arr<any>(resp?.result)
    .filter((r) => typeof r.fullName === 'string')
    .map((r) => ({ fullName: r.fullName as string, namespace: typeof r.namespacePrefix === 'string' && r.namespacePrefix ? r.namespacePrefix : undefined }));
}

/** Members of a folder type as `Folder/Name`, plus the folders themselves (which are members of the same type). */
export async function listFolderType(c: SfClient, type: string): Promise<Listed[]> {
  const folderType = ({ Report: 'ReportFolder', Dashboard: 'DashboardFolder', Document: 'DocumentFolder', EmailTemplate: 'EmailFolder' } as Record<string, string>)[type];
  if (!folderType) return listType(c, type);
  const folders = await listType(c, folderType);
  const out: Listed[] = folders.map((f) => ({ fullName: f.fullName, namespace: f.namespace }));
  const inside = await Promise.all(folders.map((f) => listType(c, type, f.fullName)));
  for (const list of inside) out.push(...list);
  return out;
}
