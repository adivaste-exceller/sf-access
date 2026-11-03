import type { TraceKind } from '../../src/shared/resolve';

/** One line in a section. */
export interface Row {
  key: string;
  name: string;
  sub?: string;
  /** Right-aligned plain text, e.g. org-wide default or expiry. */
  extra?: string;
  mask?: number;
  via?: string[];
  /** Apex classes: true for test classes. */
  test?: boolean;
  /** Group heading shown above consecutive rows with the same value (flow and LWC traces group by object). */
  group?: string;
  /** Object API name behind the group, so exclusion rules can match it. */
  obj?: string | null;
  /** Something missing for the row to work, shown in amber. */
  warn?: string;
  /** Grants that name no real item (internal apps granted to every permission set); hidden and counted instead. */
  internal?: boolean;
  /** Trace rows: the best way in, every way in, its entry point name and how many more routes there are. */
  kind?: TraceKind;
  kinds?: TraceKind[];
  entry?: string;
  more?: number;
}

export interface SectionData {
  key: string;
  title: string;
  rows: Row[];
  /** Rows removed by exclusion rules or filters. */
  hidden: number;
  flags?: [string, number][];
  note?: string;
}

export type OnMenu = (e: React.MouseEvent, data: SectionData, row: Row | null) => void;
