"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { authClient } from "@/lib/auth-browser";

interface DirtyNavigationDialogProps {
  [key: string]: unknown;
  open: boolean;
  destinationLabel: string;
  pending: boolean;
  onStay: () => void;
  onDiscard: () => void;
  onSaveAndContinue: () => void;
  themeClassName?: string;
}

export function DirtyNavigationDialog({
  open,
  destinationLabel,
  pending,
  onStay,
  onDiscard,
  onSaveAndContinue,
  themeClassName,
}: DirtyNavigationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const stayButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    (stayButtonRef.current ?? dialogRef.current)?.focus();

    return () => {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) {
        previous.focus();
      } else {
        document.querySelector<HTMLElement>("#offer-editor-main")?.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!pending) onStay();
      return;
    }
    if (event.key === "Tab") {
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }

  return (
    <div data-wmee-scope="offer" className={`${themeClassName ?? ""} fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4`}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onDialogKeyDown}
        className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-2xl sm:p-7"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
          Ungespeicherte Änderungen
        </p>
        <h2 id={titleId} className="mt-2 text-xl font-semibold text-slate-950">
          Möchtest du den lokalen Entwurf verlassen?
        </h2>
        <p id={descriptionId} className="mt-3 text-sm leading-6 text-slate-600">
          Beim Wechsel zu „{destinationLabel}“ gehen ungespeicherte Änderungen verloren.
          Bleiben ist die sichere Auswahl.
        </p>
        <div className="mt-6 grid gap-2 sm:grid-cols-3">
          <button
            ref={stayButtonRef}
            type="button"
            disabled={pending}
            onClick={onStay}
            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait"
          >
            Bleiben
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onDiscard}
            className="min-h-11 rounded-md border border-rose-300 bg-rose-50 px-3 text-sm font-semibold text-rose-800 outline-none hover:bg-rose-100 focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2 disabled:cursor-wait"
          >
            Verwerfen
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onSaveAndContinue}
            className="min-h-11 rounded-md bg-slate-950 px-3 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait"
          >
            {pending ? "Speichert …" : "Speichern und fortfahren"}
          </button>
        </div>
      </div>
    </div>
  );
}

type Destination =
  | { kind: "link"; href: string; label: string }
  | { kind: "history"; label: string }
  | { kind: "logout"; label: string };

interface DirtyNavigationGuardProps {
  dirty: boolean;
  hydrating: boolean;
  pending: boolean;
  save: () => Promise<boolean>;
  children: ReactNode;
  themeClassName?: string;
}

export function DirtyNavigationGuard({
  dirty,
  hydrating,
  pending,
  save,
  children,
  themeClassName,
}: DirtyNavigationGuardProps) {
  const router = useRouter();
  const [destination, setDestination] = useState<Destination | null>(null);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const allowHistoryRef = useRef(false);
  const dirtyRef = useRef(dirty || hydrating);
  const historySentinelRef = useRef(false);
  const guardedUrlRef = useRef("");

  useEffect(() => {
    // Hydration protects a redacted recovery envelope just like a dirty
    // in-memory draft: reload/history must stay guarded until it is applied.
    dirtyRef.current = dirty || hydrating;
    guardedUrlRef.current ||= window.location.href;
    const state = window.history.state as { offerDirtyGuard?: unknown } | null;
    if (state?.offerDirtyGuard === true) historySentinelRef.current = true;

    // A conflict reload hydrates the local draft from Session Storage after
    // the first client render. Until that decision is complete, `dirty=false`
    // is only a transient placeholder and must not pop an existing sentinel.
    if (hydrating) return;

    if (dirty && !historySentinelRef.current) {
      window.history.pushState({ offerDirtyGuard: true }, "", guardedUrlRef.current);
      historySentinelRef.current = true;
      return;
    }
    if (!dirty && historySentinelRef.current) {
      allowHistoryRef.current = true;
      historySentinelRef.current = false;
      window.history.back();
    }
  }, [dirty, hydrating]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }

    function onPopState() {
      if (allowHistoryRef.current) {
        allowHistoryRef.current = false;
        return;
      }
      if (!dirtyRef.current || !historySentinelRef.current) return;
      window.history.pushState({ offerDirtyGuard: true }, "", guardedUrlRef.current);
      setDestination({ kind: "history", label: "vorherige Seite" });
    }

    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  function navigate(next: Destination) {
    if (next.kind === "link") {
      router.push(next.href);
      return;
    }
    if (next.kind === "history") {
      allowHistoryRef.current = true;
      historySentinelRef.current = false;
      window.history.go(-2);
      return;
    }
    void signOut();
  }

  async function signOut() {
    setLogoutFailed(false);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setLogoutFailed(true);
        return;
      }
      window.location.replace("/login");
    } catch {
      setLogoutFailed(true);
    }
  }

  async function saveAndContinue() {
    if (!destination || pending) return;
    const saved = await save();
    if (!saved) {
      setDestination(null);
      return;
    }
    const next = destination;
    setDestination(null);
    navigate(next);
  }

  function discardAndContinue() {
    if (!destination || pending) return;
    const next = destination;
    setDestination(null);
    navigate(next);
  }

  return (
    <>
      {children}
      {logoutFailed ? (
        <p role="alert" className="mt-2 text-sm font-medium text-rose-700">
          Abmeldung fehlgeschlagen. Dein Entwurf bleibt geöffnet.
        </p>
      ) : null}
      <DirtyNavigationDialog
        open={destination !== null}
        destinationLabel={destination?.label ?? "andere Seite"}
        pending={pending}
        onStay={() => setDestination(null)}
        onDiscard={discardAndContinue}
        onSaveAndContinue={() => void saveAndContinue()}
        themeClassName={themeClassName}
      />
    </>
  );
}

export function GuardedOfferLink({
  href,
  label,
  dirty,
  onBlockedNavigation,
  children,
  className,
}: {
  href: string;
  label: string;
  dirty: boolean;
  onBlockedNavigation: (destination: { href: string; label: string }) => void;
  children: ReactNode;
  className?: string;
}) {
  function onNavigate(event: { preventDefault: () => void }) {
    if (!dirty) return;
    event.preventDefault();
    onBlockedNavigation({ href, label });
  }

  return (
    <Link href={href} onNavigate={onNavigate} className={className}>
      {children}
    </Link>
  );
}

export function GuardedSignOutButton({
  dirty,
  pending,
  onBlockedSignOut,
}: {
  dirty: boolean;
  pending: boolean;
  onBlockedSignOut: () => void;
}) {
  const [failed, setFailed] = useState(false);

  async function signOut() {
    if (pending) return;
    if (dirty) {
      onBlockedSignOut();
      return;
    }
    setFailed(false);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setFailed(true);
        return;
      }
      window.location.replace("/login");
    } catch {
      setFailed(true);
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() => void signOut()}
        className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait"
      >
        Abmelden
      </button>
      {failed ? (
        <p role="alert" className="mt-1 text-xs text-rose-700">Abmeldung fehlgeschlagen.</p>
      ) : null}
    </div>
  );
}
