export class IllegalTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function createStateMachine<S extends string>(transitions: Record<S, readonly S[]>) {
  return {
    states: Object.keys(transitions) as S[],
    canTransition(from: S, to: S): boolean {
      return (transitions[from] ?? []).includes(to);
    },
    assertTransition(from: S, to: S): void {
      if (!this.canTransition(from, to)) throw new IllegalTransitionError(from, to);
    },
  };
}
