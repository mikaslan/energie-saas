"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCUMENT_TYPE_LABELS } from "./labels";
import { commercialDocumentTypes } from "@/lib/integrations/invoicing/contract";

const tabClass =
  "inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2";
const activeClass = "border-blue-700 text-blue-800";
const inactiveClass =
  "border-transparent text-slate-600 hover:text-slate-950";

export function InvoicingNav({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const base = `/w/${workspaceId}/rechnungen`;

  const tabs = [
    { href: base, label: "Übersicht", active: pathname === base },
    ...commercialDocumentTypes.map((type) => ({
      href: `${base}/${type}`,
      label: DOCUMENT_TYPE_LABELS[type],
      active: pathname === `${base}/${type}`,
    })),
    { href: `${base}/berichte`, label: "Berichte", active: pathname === `${base}/berichte` },
  ];

  return (
    <nav aria-label="Rechnungsansichten" className="mb-6 flex flex-wrap gap-2 border-b border-slate-300">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? "page" : undefined}
          className={`${tabClass} ${tab.active ? activeClass : inactiveClass}`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
