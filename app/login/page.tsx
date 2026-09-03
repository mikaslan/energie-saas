import { redirect } from "next/navigation";
import { safeInternalNextPath } from "@/lib/safe-next";
import { getSessionUser } from "@/lib/session";
import { isLocalPreview } from "@/lib/preview-auth";
import { LoginForm } from "./login-form";

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams;
  const nextPath = safeInternalNextPath(query.next);
  if (await getSessionUser()) redirect(nextPath);

  const demoLoginEmail = isLocalPreview() ? process.env.DEMO_LOGIN_EMAIL ?? null : null;

  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-slate-100 px-4 py-12 text-slate-950">
      <section
        aria-labelledby="login-heading"
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
      >
        <header className="mb-8">
          <div className="mb-6 flex items-center gap-3" aria-label="WMEE">
            <span
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-md bg-blue-700 text-sm font-bold text-white"
            >
              W
            </span>
            <span className="text-sm font-semibold tracking-[0.18em] text-slate-700">WMEE</span>
          </div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
            Sicherer Zugang
          </p>
          <h1 id="login-heading" className="text-2xl font-semibold tracking-tight text-slate-950">
            Bei WMEE anmelden
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Du erhältst einen einmaligen sechsstelligen Code per E-Mail.
          </p>
        </header>

        <LoginForm nextPath={nextPath} demoLoginEmail={demoLoginEmail} />
      </section>
    </main>
  );
}
