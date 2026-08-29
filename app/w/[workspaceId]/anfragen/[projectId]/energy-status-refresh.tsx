"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function EnergyStatusRefresh({ statusLabel }: { statusLabel: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [announcement, setAnnouncement] = useState(
    `Aktueller Stand: ${statusLabel}.`,
  );

  const refresh = () => {
    setAnnouncement(
      "Die Aktualisierung wurde angefordert. Der neue Serverstand wird angezeigt, sobald er vorliegt.",
    );
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <div className="mt-4 grid gap-2">
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-100 disabled:text-slate-500 sm:w-auto"
      >
        {pending ? "Status wird aktualisiert …" : "Status aktualisieren"}
      </button>
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </p>
    </div>
  );
}
