import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { NavLinks } from "@/components/shell/nav-links";
import { SessionCostChip } from "@/components/shell/SessionCostChip";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Flora + Lamp",
  description:
    "One-pass Flora and exact two-pass Lamp video relight workflows",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-[family-name:var(--font-geist-sans)] antialiased`}
      >
        <header className="sticky top-0 z-40 flex min-h-14 flex-wrap items-center gap-x-4 border-b border-edge bg-surface px-4 sm:flex-nowrap sm:items-stretch sm:gap-x-5 sm:px-5">
          <div className="flex h-14 items-center gap-2 self-center">
            <span className="text-sm font-semibold text-ink">
              <span className="text-accent">◐</span> Flora + Lamp
            </span>
            <span className="hidden text-2xs text-faint sm:inline">
              relight workspace
            </span>
          </div>
          <div className="order-3 flex h-12 w-full items-stretch justify-start overflow-hidden sm:order-none sm:h-auto sm:w-auto sm:flex-1 sm:justify-center">
            <NavLinks />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3 self-center whitespace-nowrap">
            {/* Persistence dot + spend chip + MOCK/LIVE badge (client — reads store.mode). */}
            <SessionCostChip />
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
