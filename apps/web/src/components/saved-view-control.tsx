'use client';

import { useEffect, useState } from 'react';

interface StoredView {
  readonly label: string;
  readonly href: string;
  readonly scope: string;
  readonly savedAt: string;
}

const STORAGE_KEY = 'trustcircle-saved-views-v1';

function readViews(): readonly StoredView[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is StoredView =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as StoredView).label === 'string' &&
            typeof (item as StoredView).href === 'string' &&
            typeof (item as StoredView).scope === 'string' &&
            typeof (item as StoredView).savedAt === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

export function SavedViewControl({ scope }: { readonly scope: string }) {
  const [views, setViews] = useState<readonly StoredView[]>([]);
  const [message, setMessage] = useState('');
  useEffect(() => setViews(readViews().filter((view) => view.scope === scope)), [scope]);
  function save() {
    const label = window.prompt('Name this scoped view');
    if (!label?.trim()) return;
    const candidate: StoredView = {
      label: label.trim().slice(0, 80),
      href: `${window.location.pathname}${window.location.search}`,
      scope,
      savedAt: new Date().toISOString(),
    };
    const retained = readViews().filter(
      (view) => !(view.scope === scope && view.href === candidate.href),
    );
    const next = [candidate, ...retained].slice(0, 20);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setViews(next.filter((view) => view.scope === scope));
    setMessage('View saved in this browser for the current tenant and role scope.');
  }
  return (
    <section className="saved-view-control" aria-labelledby="saved-view-heading">
      <div>
        <h2 id="saved-view-heading">My saved views</h2>
        <p>Only filter metadata is stored locally; governed record content is never copied.</p>
      </div>
      <button type="button" onClick={save}>
        Save current view
      </button>
      {message ? <p role="status">{message}</p> : null}
      {views.length > 0 ? (
        <ul>
          {views.map((view) => (
            <li key={`${view.href}-${view.savedAt}`}>
              <a href={view.href}>{view.label}</a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
