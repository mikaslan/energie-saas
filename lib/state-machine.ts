export class IllegalTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Codex-Review (Minor): assertTransition hing am Methoden-Receiver — als
// `const { assertTransition } = phase` destrukturiert oder als Callback
// (`items.forEach(phase.assertTransition)`) übergeben, scheiterte
// `this.canTransition` mit einem TypeError statt mit IllegalTransitionError.
// Ein Aufrufer, der auf IllegalTransitionError prüft, hätte den Fehler
// durchgereicht.
//
// Beide Methoden sind deshalb Closures über `transitions` — sie brauchen
// keinen Receiver. Zusätzlich wird die übergebene Matrix defensiv kopiert und
// eingefroren: vorher konnte der Aufrufer die Matrix NACH dem Erzeugen der
// Maschine noch verändern und damit Übergänge nachträglich erlauben.
// ═══════════════════════════════════════════════════════════════════════
export function createStateMachine<S extends string>(transitions: Record<S, readonly S[]>) {
  // Tiefe Kopie: eigene Map + eigene Arrays. Ein `push` auf das ursprünglich
  // übergebene Array erreicht die Maschine danach nicht mehr.
  const frozen = Object.freeze(
    Object.fromEntries(
      (Object.entries(transitions) as [S, readonly S[]][]).map(([from, to]) => [
        from,
        Object.freeze([...to]),
      ]),
    ) as Record<S, readonly S[]>,
  );
  const states = Object.freeze(Object.keys(frozen) as S[]);

  function canTransition(from: S, to: S): boolean {
    return (frozen[from] ?? []).includes(to);
  }

  function assertTransition(from: S, to: S): void {
    if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  }

  return Object.freeze({ states, transitions: frozen, canTransition, assertTransition });
}
