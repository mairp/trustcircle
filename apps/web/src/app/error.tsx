'use client';

export default function GlobalError({ reset }: { readonly reset: () => void }) {
  return (
    <main id="main-content" className="state-page">
      <h1>Console view unavailable</h1>
      <p role="alert">
        The requested view could not be rendered. No healthy or complete state is inferred.
      </p>
      <button type="button" onClick={reset}>
        Retry this read-only view
      </button>
    </main>
  );
}
