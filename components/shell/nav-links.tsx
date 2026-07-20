"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Creation and review stay primary for both product methods. Engine and
// Rubrics remain supporting views without competing with that loop.
const PRIMARY_LINKS = [
  { href: "/", label: "Create" },
  { href: "/library", label: "Runs" },
  { href: "/batch", label: "Batches" },
  { href: "/chain-sweep", label: "Chain sweep" },
  { href: "/grade", label: "Grade" },
] as const;

const METHOD_LINKS = [
  { href: "/pipeline", label: "Engine" },
  { href: "/prompts", label: "Rubrics" },
] as const;

function isActive(href: string, pathname: string): boolean {
  if (href === "/") {
    // Run pages are reached from Create/Runs and belong to the creation loop.
    return pathname === "/" || pathname.startsWith("/runs");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks() {
  const pathname = usePathname();
  const renderLink = ({ href, label }: { href: string; label: string }) => {
    const active = isActive(href, pathname);
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? "page" : undefined}
        className={`flex min-h-10 items-center border-b-2 px-3 text-sm transition-[color,border-color,transform] duration-150 ease-out active:scale-[0.96] ${
          active
            ? "border-accent text-ink"
            : "border-transparent text-muted hover:text-ink"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <nav className="flex items-stretch gap-1 overflow-x-auto" aria-label="Primary">
      {PRIMARY_LINKS.map(renderLink)}
      <span
        className="mx-1 hidden self-center text-2xs uppercase tracking-[0.14em] text-faint lg:inline"
        aria-hidden="true"
      >
        Method
      </span>
      {METHOD_LINKS.map(renderLink)}
    </nav>
  );
}
