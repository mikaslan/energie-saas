import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Signaturlink — noch nicht freigegeben",
  robots: { index: false, follow: false },
};

// ═══════════════════════════════════════════════════════════════════════
// M2-04 / DEC-M204-04 (Root-Bestätigung): Die öffentliche Token-Route
// rendert vor dem M2-03b2-`issued`-Gate KEIN Dokument (konservativ). Es
// wird bewusst KEINE Offer-, PDF- oder Token-Auflösung ausgeführt, damit
// auch ein abgelaufener/entzogener Link keinen Inhalts-Orakel liefert.
//
// Der öffentliche Dokument-/Signatur-Render ist als Erweiterung `M2-04b`
// eingeplant (docs/spec/M2-04-e-signatur.md §12/§14), sobald M2-03b2/issued
// existiert; das Object-Lock-Gate bleibt extern BLOCKED. Die dafür nötigen
// SECURITY-DEFINER-Kapseln (resolve_signature_public_view,
// sign_signature_by_token, record_signature_view, revoke_signature_by_customer)
// liegen bereits in drizzle/0044 vor.
// ═══════════════════════════════════════════════════════════════════════
export default function SignatureTokenPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-100 px-6 py-12">
      <section
        className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-8 shadow-sm"
        role="status"
        aria-live="polite"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          E-Signatur
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
          Signaturlink vorbereitet · noch nicht freigegeben
        </h1>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Dieser Link gehört zu einem vorbereiteten Signaturvorgang. Der
          öffentliche Zugriff auf Angebotsdokumente und Signaturseite ist bis
          zur Ausstellungs- und Versandfreigabe bewusst gesperrt.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Bitte wende dich an deine Ansprechperson. Es wurden keine Inhalte
          geladen und kein Zugriff protokolliert.
        </p>
      </section>
    </main>
  );
}
