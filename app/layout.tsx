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
  title: "Flora Relight",
  description: "Internal studio for identity-locked generative video relighting",
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
        <header className="sticky top-0 z-40 flex h-14 items-stretch gap-6 border-b border-edge bg-surface px-5">
          <div className="flex items-baseline gap-2 self-center">
            <span className="text-sm font-semibold text-ink">
              <span className="text-accent">✦</span> Flora Relight
            </span>
            <span className="hidden text-2xs text-faint sm:inline">
              relight studio
            </span>
          </div>
          <div className="flex flex-1 items-stretch justify-center">
            <NavLinks />
          </div>
          <div className="flex shrink-0 items-center gap-3 self-center whitespace-nowrap">
            {/* Persistence dot + spend chip + MOCK/LIVE badge (client — reads store.mode). */}
            <SessionCostChip />
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
