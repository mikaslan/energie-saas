"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-browser";

export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setFailed(true);
        setPending(false);
        return;
      }
      window.location.replace("/login");
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-wait disabled:text-slate-400"
      >
        {pending ? "Abmeldung …" : "Abmelden"}
      </button>
      {failed ? (
        <p role="alert" className="mt-1 max-w-48 text-xs text-red-700">
          Abmeldung fehlgeschlagen. Bitte erneut versuchen.
        </p>
      ) : null}
    </div>
  );
}
