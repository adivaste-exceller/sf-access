import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icon, IconTile, LOOK, DEFAULT_LOOK } from './icons';
import { ALL_KEY, compileRules, type Rules } from './filters';

export interface RuleTarget {
  key: string;
  title: string;
}

/** Quick-add patterns. Clicking a chip appends its lines to that section's rules. */
const PRESETS: Record<string, { label: string; lines: string[] }[]> = {
  objects: [
    { label: 'History / Feed / ChangeEvent', lines: ['*History', '*Feed', '*ChangeEvent'] },
    { label: 'Custom metadata (__mdt)', lines: ['*__mdt'] },
    { label: 'Managed package objects', lines: ['/^[a-z0-9]+__.+__[a-z]+$/i'] },
  ],
  fields: [{ label: 'Managed package fields', lines: ['/__[a-z0-9]+__.+__[a-z]+$/i'] }],
  ApexClass: [{ label: 'Managed package (ns.*)', lines: ['*.*'] }],
  ApexPage: [{ label: 'Managed package (ns.*)', lines: ['*.*'] }],
};

export function Settings(props: { targets: RuleTarget[]; rules: Rules; onChange: (r: Rules) => void; onClose: () => void }) {
  const { targets, rules, onChange, onClose } = props;
  const { errors } = compileRules(rules);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (key: string, text: string) => onChange({ ...rules, [key]: text });
  const addLines = (key: string, lines: string[]) => {
    const have = new Set((rules[key] ?? '').split('\n').map((l) => l.trim()));
    const add = lines.filter((l) => !have.has(l));
    if (add.length) set(key, [(rules[key] ?? '').replace(/\s+$/, ''), ...add].filter(Boolean).join('\n'));
  };
  const active = Object.values(rules).filter((t) => t.trim()).length;

  const all: RuleTarget[] = [{ key: ALL_KEY, title: 'Everything' }, ...targets];
  // Portal to <body> so the app's grid layout can never affect the overlay.
  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Exclusion rules">
        <div className="modal-head">
          <div>
            <div className="modal-title">Exclude from results</div>
            <div className="muted small">
              One pattern per line. <code className="mono">*</code> any characters, <code className="mono">?</code> one character, <code className="mono">/regex/</code> for regular expressions, <code className="mono">#</code> comment. Case-insensitive; matches the name or API name.
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">
          {all.map((t) => {
            const look = t.key === ALL_KEY ? { icon: 'sliders' as const, hue: 'gray' } : (LOOK[t.key] ?? DEFAULT_LOOK);
            const bad = errors[t.key];
            return (
              <div key={t.key} className="rule">
                <div className="rule-head">
                  <IconTile name={look.icon} hue={look.hue} />
                  <span className="rule-title">{t.title}</span>
                  {t.key === ALL_KEY && <span className="muted small">applies to every section</span>}
                </div>
                <textarea
                  className="input mono rule-text"
                  rows={Math.min(6, Math.max(2, (rules[t.key] ?? '').split('\n').length))}
                  spellCheck={false}
                  placeholder={t.key === 'objects' ? 'e.g.  Account*\n/^Temp_/' : t.key === 'ApexClass' ? 'e.g.  *Test\nfflib_*' : ''}
                  value={rules[t.key] ?? ''}
                  onChange={(e) => set(t.key, e.target.value)}
                />
                {bad && <div className="rule-err small">Invalid pattern ignored: {bad.join(', ')}</div>}
                {PRESETS[t.key] && (
                  <div className="presets">
                    {PRESETS[t.key]!.map((p) => (
                      <button key={p.label} className="preset small" onClick={() => addLines(t.key, p.lines)}>
                        + {p.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="modal-foot">
          <span className="muted small">{active ? `${active} section(s) with rules · saved in this browser` : 'No rules yet · saved in this browser'}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => onChange({})} disabled={!active}>
            Clear all
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
