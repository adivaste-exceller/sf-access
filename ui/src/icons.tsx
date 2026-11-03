import type { ReactNode } from 'react';

// Small stroke icons (24px grid, drawn at 14-16px). Kept deliberately plain.
const PATHS: Record<string, ReactNode> = {
  chevron: <path d="M9 6l6 6-6 6" />,
  object: <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5" />,
  field: <path d="M4 6h16M4 12h16M4 18h10" />,
  code: <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12" />,
  page: <path d="M7 3h7l5 5v13H7zM14 3v5h5" />,
  flow: <path d="M6 7v3a4 4 0 004 4h6M18 7v10M6 4.5a1 1 0 100 .01M18 4.5a1 1 0 100 .01M18 19.5a1 1 0 100 .01" />,
  app: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
  tab: <path d="M3 7h18v13H3zM3 11h18M7 7V4h6v3" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3" />
    </>
  ),
  shield: <path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z" />,
  plug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0113 0M16 5a3.5 3.5 0 010 7M18 14.5a6.5 6.5 0 013.5 5.5" />
    </>
  ),
  layers: <path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5" />,
  sliders: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  route: (
    <>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 18H15a3 3 0 003-3V8.5M6 15.5V9a3 3 0 013-3h6.5" />
    </>
  ),
  puzzle: <path d="M4 5h6v2.5a2 2 0 104 0V5h6v6h-2.5a2 2 0 100 4H20v6h-6v-2.5a2 2 0 10-4 0V21H4v-6h2.5a2 2 0 100-4H4z" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14, stroke = 1.9, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** Tinted square behind an icon. `hue` selects one of the muted palette classes in styles.css. */
export function IconTile({ name, hue }: { name: IconName; hue: string }) {
  return (
    <span className={`ico h-${hue}`}>
      <Icon name={name} size={13} />
    </span>
  );
}

export interface Look {
  icon: IconName;
  hue: string;
}

/** Icon and hue per section key (setup entity type names, or the fixed keys below). */
export const LOOK: Record<string, Look> = {
  objects: { icon: 'object', hue: 'blue' },
  fields: { icon: 'field', hue: 'blue' },
  triggers: { icon: 'bolt', hue: 'orange' },
  recordFlows: { icon: 'flow', hue: 'green' },
  flowTrace: { icon: 'route', hue: 'green' },
  lwcTrace: { icon: 'puzzle', hue: 'cyan' },
  ApexClass: { icon: 'code', hue: 'violet' },
  ApexPage: { icon: 'page', hue: 'amber' },
  FlowDefinition: { icon: 'flow', hue: 'green' },
  TabSet: { icon: 'app', hue: 'teal' },
  tabs: { icon: 'tab', hue: 'teal' },
  CustomPermission: { icon: 'key', hue: 'amber' },
  system: { icon: 'shield', hue: 'rose' },
  ConnectedApplication: { icon: 'plug', hue: 'pink' },
  ExternalClientApplication: { icon: 'plug', hue: 'pink' },
  sources: { icon: 'users', hue: 'gray' },
  people: { icon: 'users', hue: 'gray' },
};
export const DEFAULT_LOOK: Look = { icon: 'layers', hue: 'gray' };
