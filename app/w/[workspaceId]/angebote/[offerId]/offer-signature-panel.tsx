import { authorizedQuery } from "@/lib/action";
import {
  listSignatureRequests,
  type SignatureRequestDto,
} from "@/modules/signatures";
import {
  AnalogSignatureForm,
  CreateSignatureForm,
  WithdrawSignatureForm,
} from "./signature-controls";

function shortHash(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

function statusLabel(status: SignatureRequestDto["status"]): string {
  switch (status) {
    case "pending": return "wartet auf Signatur";
    case "signed": return "signiert";
    case "expired": return "abgelaufen";
    case "withdrawn": return "widerrufen";
    case "revoked_by_customer": return "vom Kunden widerrufen";
  }
}

function formatInstant(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
}

export async function OfferSignaturePanel(props: {
  workspaceId: string;
  offerId: string;
  variantId: string | null;
}) {
  const requests = await authorizedQuery(
    props.workspaceId,
    "offer.signature.read",
    "signature_request",
    (tx, ctx) => listSignatureRequests(tx, ctx, {
      workspaceId: props.workspaceId,
      offerId: props.offerId,
    }),
  );

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">E-Signatur</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">Signaturanforderungen</h2>
        </div>
        <p className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
          vorbereitet · nicht versendet
        </p>
      </div>

      {requests.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600">
          Noch keine Signaturanforderung. An einer freigegebenen Ausstellungsfassung kann ein
          Signaturlink mit 14 Tagen Gültigkeit vorbereitet werden.
        </p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {requests.map((request) => (
            <li key={request.requestId} className="rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  request.status === "pending" ? "bg-blue-100 text-blue-800"
                    : request.status === "signed" ? "bg-green-100 text-green-800"
                      : request.status === "revoked_by_customer" ? "bg-red-100 text-red-800"
                        : "bg-slate-100 text-slate-600"
                }`}>
                  {statusLabel(request.status)}
                </span>
                <span className="text-xs text-slate-500">
                  gültig bis {formatInstant(request.expiresAt)}
                </span>
                <span className="text-xs text-slate-500">
                  {request.viewCount} Öffnung{request.viewCount === 1 ? "" : "en"}
                  {request.firstViewedAt ? ` · zuerst ${formatInstant(request.firstViewedAt)}` : ""}
                </span>
              </div>

              {request.attestation ? (
                <dl className="mt-3 grid gap-1 text-sm text-slate-700 sm:grid-cols-2">
                  <div><dt className="text-xs text-slate-500">Unterzeichnet von</dt>
                    <dd>{request.attestation.signerName} ({request.attestation.mode})</dd></div>
                  <div><dt className="text-xs text-slate-500">Signiert am</dt>
                    <dd>{formatInstant(request.attestation.signedAt)}</dd></div>
                  <div className="sm:col-span-2">
                    <dt className="text-xs text-slate-500">Content-Hash (gekürzt)</dt>
                    <dd className="font-mono text-xs">{shortHash(request.attestation.contentSha256Hex)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-3 text-xs text-slate-500">
                  Content-Hash {shortHash(request.contentSha256Hex)} · noch keine Attestierung
                </p>
              )}

              {request.status === "pending" ? (
                <div className="mt-3 flex flex-wrap gap-3">
                  <WithdrawSignatureForm workspaceId={props.workspaceId} requestId={request.requestId} />
                  <AnalogSignatureForm workspaceId={props.workspaceId} requestId={request.requestId} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {props.variantId ? (
        <div className="mt-6 border-t border-slate-100 pt-5">
          <CreateSignatureForm
            workspaceId={props.workspaceId}
            offerId={props.offerId}
            variantId={props.variantId}
          />
        </div>
      ) : (
        <p className="mt-6 border-t border-slate-100 pt-5 text-xs text-slate-500">
          Wähle eine freigegebene Ausstellungsfassung, um einen Signaturlink vorzubereiten.
        </p>
      )}
    </section>
  );
}
