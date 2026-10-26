import { useEffect, useState } from 'react';
import type { Snapshot } from '../../src/shared/types';
import { loadSnapshot } from './load';
import { Workspace } from './Workspace';

type Theme = 'dark' | 'light';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    loadSnapshot().then(setSnap, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  if (error) return <div className="splash">{error}</div>;
  if (!snap) return <div className="splash">Loading snapshot…</div>;
  return <Workspace snap={snap} theme={theme} onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />;
}
