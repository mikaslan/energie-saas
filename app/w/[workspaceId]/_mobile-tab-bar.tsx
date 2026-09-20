"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeMobileTabId, tabsForWorkspace } from "@/lib/mobile/tabs";

const tabClass =
  "flex min-h-11 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600";
// Nicht-farbliches Aktiv-Signal (fett statt semibold) + aria-current;
// Farbe allein wäre für Sehende das einzige Unterscheidungsmerkmal.
const activeClass = "font-bold text-brand-800";
const inactiveClass = "font-semibold text-slate-600 hover:text-slate-950";

export function MobileTabBar({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const tabs = tabsForWorkspace(workspaceId);
  const activeId = activeMobileTabId(pathname, workspaceId);

  return (
    <nav
      aria-label="Workspace-Bereiche"
      data-testid="mobile-tab-bar"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur md:hidden"
    >
      <ul className="mx-auto grid w-full max-w-xl grid-cols-5">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <li key={tab.id} className="min-w-0">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`${tabClass} ${active ? activeClass : inactiveClass}`}
              >
                <span aria-hidden="true" className={`h-1 w-6 rounded-full ${active ? "bg-brand-700" : "bg-transparent"}`} />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
