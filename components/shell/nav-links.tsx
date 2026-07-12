"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Studio" },
  { href: "/library", label: "Library" },
  { href: "/batch", label: "Batch" },
  { href: "/pipeline", label: "Engine" },
  { href: "/prompts", label: "Rubrics" },
] as const;

function isActive(href: string, pathname: string): boolean {
  if (href === "/") {
    // Run pages are reached from Studio/Batch, not the nav — they live under Studio's domain.
    return pathname === "/" || pathname.startsWith("/runs");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex items-stretch gap-1" aria-label="Primary">
      {LINKS.map(({ href, label }) => {
        const active = isActive(href, pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center border-b-2 px-3 text-sm transition ${
              active
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
