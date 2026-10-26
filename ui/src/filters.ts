/**
 * Exclusion rules. One text blob per section key ("objects", "ApexClass", ...), plus "all" which applies everywhere.
 * One pattern per line: `*` = any characters, `?` = one character, `/regex/flags` = regular expression,
 * `#` starts a comment. Matching is case-insensitive and anchored for wildcards.
 */
export type Rules = Record<string, string>;

export const ALL_KEY = 'all';

export interface Compiled {
  /** True when any rule for `key` (or "all") matches any of the given strings. */
  excluded(key: string, texts: (string | undefined)[]): boolean;
  /** Lines that could not be parsed, per key. */
  errors: Record<string, string[]>;
}

function parseLine(line: string): RegExp {
  const m = /^\/(.+)\/([a-z]*)$/.exec(line);
  if (m) return new RegExp(m[1]!, m[2] || 'i');
  const escaped = line.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function compileRules(rules: Rules): Compiled {
  const tests = new Map<string, RegExp[]>();
  const errors: Record<string, string[]> = {};
  for (const [key, text] of Object.entries(rules)) {
    const list: RegExp[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      try {
        list.push(parseLine(line));
      } catch {
        (errors[key] ??= []).push(line);
      }
    }
    if (list.length) tests.set(key, list);
  }
  const hit = (list: RegExp[] | undefined, texts: string[]) => !!list && list.some((re) => texts.some((t) => re.test(t)));
  return {
    errors,
    excluded(key, texts) {
      const t = texts.filter((x): x is string => !!x);
      return hit(tests.get(key), t) || hit(tests.get(ALL_KEY), t);
    },
  };
}

const STORAGE_KEY = 'exclusion-rules';

export function loadRules(): Rules {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Rules;
  } catch {
    /* storage unavailable or corrupt */
  }
  return {};
}

export function saveRules(rules: Rules): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch {
    /* storage unavailable */
  }
}
