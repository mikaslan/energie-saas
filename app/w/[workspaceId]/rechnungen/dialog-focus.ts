"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Modaler Dialog-Vertrag (Spec §11, Kimi-P2-4): Escape schließt, Tab bleibt
 * im Dialog (Fokus-Falle), beim Unmount wandert der Fokus zurück zum Trigger.
 * Kein setState im Effect — nur Listener und Fokus-Operationen.
 */
export function useModalDialog(
  onClose: () => void,
  triggerRef: RefObject<HTMLButtonElement | null>,
): RefObject<HTMLDivElement | null> {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", handleKeyDown);
    return () => {
      node.removeEventListener("keydown", handleKeyDown);
      triggerRef.current?.focus();
    };
  }, [onClose, triggerRef]);

  return dialogRef;
}
