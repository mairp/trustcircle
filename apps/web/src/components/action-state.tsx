export type ActionResultState = 'pending' | 'denied' | 'unknown' | 'confirmed';

export function ActionState({ state }: { readonly state: ActionResultState }) {
  const text: Readonly<Record<ActionResultState, string>> = {
    pending: 'Pending authoritative reconciliation; no success is claimed.',
    denied: 'Denied by the governed authority boundary.',
    unknown: 'Outcome unknown; no success is claimed.',
    confirmed: 'Confirmed by a subsequent authoritative versioned read.',
  };
  return (
    <p role="status" data-action-state={state}>
      {text[state]}
    </p>
  );
}
