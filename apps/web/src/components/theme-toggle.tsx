'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'trustcircle-theme';

function storedTheme(): Theme | null {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}

function preferredTheme(): Theme {
  return (
    storedTheme() ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset['theme'] = theme;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const initialTheme = preferredTheme();
    applyTheme(initialTheme);
    setTheme(initialTheme);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const followSystemTheme = (event: MediaQueryListEvent) => {
      if (storedTheme()) return;
      const nextTheme = event.matches ? 'dark' : 'light';
      applyTheme(nextTheme);
      setTheme(nextTheme);
    };

    media.addEventListener('change', followSystemTheme);
    return () => media.removeEventListener('change', followSystemTheme);
  }, []);

  // A switch whose accessible name contains its visible label (WCAG 2.5.3); state is aria-checked.
  const label = 'Dark theme';

  return (
    <button
      className="theme-toggle"
      type="button"
      role="switch"
      aria-checked={theme === 'dark'}
      aria-label={label}
      title={label}
      onClick={() => {
        const selectedTheme: Theme = theme === 'dark' ? 'light' : 'dark';
        try {
          window.localStorage.setItem(STORAGE_KEY, selectedTheme);
        } catch {
          // Theme still works for this page when persistent storage is unavailable.
        }
        applyTheme(selectedTheme);
        setTheme(selectedTheme);
      }}
    >
      <span className="theme-toggle__track" aria-hidden="true">
        <span className="theme-toggle__icon theme-toggle__icon--sun">
          <svg viewBox="0 0 24 24" focusable="false">
            <circle cx="12" cy="12" r="3.5" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
          </svg>
        </span>
        <span className="theme-toggle__thumb" />
        <span className="theme-toggle__icon theme-toggle__icon--moon">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M20 15.2A8.4 8.4 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z" />
          </svg>
        </span>
      </span>
      <span className="theme-toggle__label">{label}</span>
    </button>
  );
}
