import { z } from "zod";

// F11-06 Quick Actions: reine Aktionsableitung aus Kontaktwegen und
// Adresse (kein DB-Zugriff, kein I/O). Aktionen ohne Datum entfallen —
// es gibt keine deaktivierten Buttons und keine toten Links.

export const quickActionSchema = z.strictObject({
  id: z.enum(["call", "sms", "whatsapp", "email", "navigate"]),
  label: z.string().min(1).max(40),
  href: z.string().min(1).max(2000),
  external: z.boolean(),
});
export type QuickAction = z.infer<typeof quickActionSchema>;
export type QuickActionId = QuickAction["id"];

// Strukturelle Minimalform (ContactWaysV1/ContactAddressV1 aus dem
// Kontaktvertrag sind zuweisbar, ohne ihn hier zu importieren).
export type QuickActionContactWays = {
  primaryEmail: string | null;
  secondaryEmail: string | null;
  phone: string | null;
  phoneMobile: string | null;
};

export type QuickActionAddress = {
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
};

const E164_PATTERN = /^\+[1-9][0-9]{1,14}$/u;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/u;

function navigationQuery(address: QuickActionAddress): string | null {
  const { street, houseNumber, postalCode, city, country } = address;
  if (!city || (!street && !postalCode)) return null;
  const streetPart = street ? [street, houseNumber].filter(Boolean).join(" ") : null;
  const cityPart = [postalCode, city].filter(Boolean).join(" ");
  return [streetPart, cityPart, country].filter(Boolean).join(", ");
}

// Tote-Links-Verbot als Tiefenschutz: Der Upstream-Vertrag garantiert
// E.164/Geformtes bereits — der Helfer verlaesst sich trotzdem nicht
// darauf, sondern laesst ungeformte Kandidaten aus (statt zu werfen:
// der Render-Pfad darf nie crashen).
function pushAction(actions: QuickAction[], candidate: unknown): void {
  const parsed = quickActionSchema.safeParse(candidate);
  if (parsed.success) actions.push(parsed.data);
}

export function quickActionsForContact(
  ways: QuickActionContactWays,
  address: QuickActionAddress,
): QuickAction[] {
  const actions: QuickAction[] = [];
  const voice = [ways.phoneMobile, ways.phone].find(
    (candidate): candidate is string => !!candidate && E164_PATTERN.test(candidate),
  );
  if (voice) {
    const digits = voice.replace(/^\+/u, "");
    pushAction(actions, { id: "call", label: "Anrufen", href: `tel:${voice}`, external: false });
    pushAction(actions, { id: "sms", label: "SMS", href: `sms:${voice}`, external: false });
    pushAction(actions, {
      id: "whatsapp",
      label: "WhatsApp",
      href: `https://wa.me/${digits}`,
      external: true,
    });
  }
  const email = [ways.primaryEmail, ways.secondaryEmail].find(
    (candidate): candidate is string => !!candidate && EMAIL_PATTERN.test(candidate),
  );
  if (email) {
    pushAction(actions, { id: "email", label: "E-Mail", href: `mailto:${email}`, external: false });
  }
  const query = navigationQuery(address);
  if (query) {
    pushAction(actions, {
      id: "navigate",
      label: "Navigation",
      href: `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`,
      external: true,
    });
  }
  return actions;
}

export type QuickActionDataset = {
  deletedAt: string | null;
  contactWays: QuickActionContactWays;
  address: QuickActionAddress;
};

export function quickActionsForDataset(dataset: QuickActionDataset): QuickAction[] {
  if (dataset.deletedAt !== null) return [];
  return quickActionsForContact(dataset.contactWays, dataset.address);
}
