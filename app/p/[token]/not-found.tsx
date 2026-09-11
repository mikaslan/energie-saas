import { cookies } from "next/headers";

import {
  parsePortalLang,
  PORTAL_LANG_COOKIE,
  PORTAL_STRINGS,
} from "@/lib/integrations/portal/portal-language";

// F10-06: Ungültig-Seite je Cookie-Sprache (der 404-Pfad kennt weder Token
// noch ?lang=; ohne Cookie Deutsch, unbekannte Werte fallen auf Deutsch).
export default async function PortalLinkInvalid() {
  const cookieStore = await cookies();
  const lang = parsePortalLang(cookieStore.get(PORTAL_LANG_COOKIE)?.value);
  const t = PORTAL_STRINGS[lang];
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-6 py-12">
      <section
        className="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
        role="status"
        aria-live="polite"
        lang={lang}
      >
        <p className="text-sm font-semibold text-brand-800">{t.brand}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">{t.invalidTitle}</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          {t.invalidBody}
        </p>
      </section>
    </main>
  );
}
