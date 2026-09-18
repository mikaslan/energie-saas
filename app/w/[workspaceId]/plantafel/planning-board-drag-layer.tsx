"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { buildCreateHref, normalizeSpan } from "./drag-span";

export const DRAG_SELECTED_CLASS = "planning-board-drag-selected";
const DRAG_SELECTED_BACKGROUND = "#dbeafe";

// F7-05c: Client-Insel um das server-gerenderte <table>. Lauscht per
// Event-Delegation auf td[data-member][data-date] (Maus-Drag innerhalb
// EINER Mitgliedszeile) und navigiert per router.push auf die
// ?week=&create=&member=[&end=]-URL. Bei canWrite=false reine Hülle
// ohne Handler (Server-Gate bleibt maßgeblich).
export function PlanningBoardDragLayer({
  canWrite,
  basePath,
  weekStart,
  children,
}: {
  canWrite: boolean;
  basePath: string;
  weekStart: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const navRef = useRef({ basePath, weekStart });

  useEffect(() => {
    navRef.current = { basePath, weekStart };
    if (!canWrite) return;
    const root = rootRef.current;
    if (root === null) return;

    let startMember: string | null = null;
    let startDate: string | null = null;
    let currentEnd: string | null = null;
    let aborted = false;

    const cellOf = (target: EventTarget | null): { member: string; date: string } | null => {
      if (!(target instanceof Element)) return null;
      const cell = target.closest("td[data-member][data-date]");
      if (cell === null || !root.contains(cell)) return null;
      const member = cell.getAttribute("data-member");
      const date = cell.getAttribute("data-date");
      if (!member || !date) return null;
      return { member, date };
    };

    const paint = (): void => {
      const cells = root.querySelectorAll("td[data-member][data-date]");
      cells.forEach((cell) => {
        const selected = !aborted
          && startMember !== null
          && startDate !== null
          && currentEnd !== null
          && cell.getAttribute("data-member") === startMember
          && (() => {
            const [lo, hi] = normalizeSpan(startDate, currentEnd);
            const date = cell.getAttribute("data-date") ?? "";
            return date >= lo && date <= hi;
          })();
        cell.classList.toggle(DRAG_SELECTED_CLASS, selected);
        if (selected) {
          (cell as HTMLElement).style.backgroundColor = DRAG_SELECTED_BACKGROUND;
        } else {
          (cell as HTMLElement).style.removeProperty("background-color");
        }
      });
    };

    const reset = (): void => {
      startMember = null;
      startDate = null;
      currentEnd = null;
      aborted = false;
      paint();
    };

    const onPointerDown = (event: PointerEvent): void => {
      // Nur Maus (Touch = Scroll, ＋-Link bleibt Fallback); Links (＋)
      // behalten ihr Klick-Verhalten.
      if (event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) return;
      if (event.target instanceof Element && event.target.closest("a") !== null) return;
      const cell = cellOf(event.target);
      if (cell === null) return;
      // Textselektion beim Ziehen unterdrücken (Links sind oben ausgenommen).
      event.preventDefault();
      startMember = cell.member;
      startDate = cell.date;
      currentEnd = cell.date;
      aborted = false;
      paint();
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (startMember === null || startDate === null) return;
      const cell = cellOf(event.target);
      if (cell === null) return;
      if (cell.member !== startMember) {
        // Zeilenwechsel = Abbruch (keine Navigation).
        aborted = true;
        paint();
        return;
      }
      currentEnd = cell.date;
      paint();
    };

    const onPointerUp = (): void => {
      if (startMember === null || startDate === null || currentEnd === null) return;
      const [start, end] = aborted ? [null, null] : normalizeSpan(startDate, currentEnd);
      const member = startMember;
      reset();
      if (start === null || end === null) return;
      const nav = navRef.current;
      router.push(buildCreateHref(nav.basePath, nav.weekStart, member, start, end));
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && startMember !== null) reset();
    };

    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointermove", onPointerMove);
    // Up/Cancel am Fenster: Loslassen außerhalb der Tabelle beendet die
    // Geste sauber statt die Auswahl stehen zu lassen.
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", reset);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", reset);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [canWrite, router, basePath, weekStart]);

  return <div ref={rootRef}>{children}</div>;
}
