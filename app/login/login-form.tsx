"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-browser";

const GENERIC_AUTH_ERROR =
  "Die Anmeldung konnte nicht abgeschlossen werden. Bitte versuche es erneut.";

type LoginFormProps = {
  nextPath: string;
};

export function LoginForm({ nextPath }: LoginFormProps) {
  const [step, setStep] = useState<"email" | "otp">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const normalizedEmail = email.trim().toLowerCase();
    setPending(true);
    setError(null);

    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: normalizedEmail,
        type: "sign-in",
      });

      if (result.error) {
        setError(GENERIC_AUTH_ERROR);
        return;
      }

      setEmail(normalizedEmail);
      setOtp("");
      setStep("otp");
    } catch {
      setError(GENERIC_AUTH_ERROR);
    } finally {
      setPending(false);
    }
  }

  async function handleOtpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !/^\d{6}$/.test(otp)) return;

    setPending(true);
    setError(null);

    try {
      const result = await authClient.signIn.emailOtp({ email, otp });

      if (result.error) {
        setError(GENERIC_AUTH_ERROR);
        return;
      }

      window.location.replace(nextPath);
    } catch {
      setError(GENERIC_AUTH_ERROR);
    } finally {
      setPending(false);
    }
  }

  function returnToEmailStep() {
    if (pending) return;
    setOtp("");
    setError(null);
    setStep("email");
  }

  const fieldClassName =
    "mt-2 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 sm:text-sm";
  const primaryButtonClassName =
    "inline-flex h-11 w-full items-center justify-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white transition hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div>
      {step === "email" ? (
        <form onSubmit={handleEmailSubmit} aria-busy={pending}>
          <div className="mb-5 flex items-center justify-between gap-4 text-xs">
            <span className="font-medium text-zinc-500">Schritt 1 von 2</span>
            <span className="text-zinc-500">E-Mail</span>
          </div>

          <label htmlFor="login-email" className="block text-sm font-medium text-zinc-800">
            E-Mail-Adresse
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={254}
            required
            autoFocus
            disabled={pending}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={error !== null}
            aria-describedby={error ? "login-error" : undefined}
            className={fieldClassName}
            placeholder="name@betrieb.de"
          />

          <button type="submit" disabled={pending} className={`${primaryButtonClassName} mt-5`}>
            {pending ? "Code wird gesendet …" : "Code anfordern"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleOtpSubmit} aria-busy={pending}>
          <div className="mb-5 flex items-center justify-between gap-4 text-xs">
            <span className="font-medium text-zinc-500">Schritt 2 von 2</span>
            <span className="text-zinc-500">Bestätigungscode</span>
          </div>

          <p className="mb-5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm leading-5 text-zinc-600">
            Falls die Adresse verwendet werden kann, wurde ein Code an {email} gesendet.
          </p>

          <label htmlFor="login-otp" className="block text-sm font-medium text-zinc-800">
            Sechsstelliger Code
          </label>
          <input
            id="login-otp"
            name="otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            minLength={6}
            maxLength={6}
            required
            autoFocus
            disabled={pending}
            value={otp}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
            aria-invalid={error !== null}
            aria-describedby={error ? "login-error login-otp-hint" : "login-otp-hint"}
            className={`${fieldClassName} font-mono text-lg tracking-[0.35em] tabular-nums`}
            placeholder="000000"
          />
          <p id="login-otp-hint" className="mt-2 text-xs leading-5 text-zinc-500">
            Der Code ist nur einmal verwendbar und läuft nach kurzer Zeit ab.
          </p>

          <button
            type="submit"
            disabled={pending || otp.length !== 6}
            className={`${primaryButtonClassName} mt-5`}
          >
            {pending ? "Anmeldung wird geprüft …" : "Anmelden"}
          </button>

          <button
            type="button"
            onClick={returnToEmailStep}
            disabled={pending}
            className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-md px-4 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Andere E-Mail-Adresse verwenden
          </button>
        </form>
      )}

      <div className="min-h-12 pt-4" aria-live="polite">
        {error ? (
          <p id="login-error" role="alert" className="text-sm leading-5 text-red-700">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
