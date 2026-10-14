'use client';

import { useEffect } from 'react';

/**
 * Makes the `/` hint in the header real: pressing `/` outside a text field opens governed search,
 * or focuses the search field when already on the search page.
 */
export function SearchShortcut() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      const field = document.querySelector<HTMLInputElement>(
        'main input[type="search"], main input[name="q"]',
      );
      if (window.location.pathname === '/search' && field) {
        field.focus();
      } else {
        window.location.assign('/search');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return null;
}
