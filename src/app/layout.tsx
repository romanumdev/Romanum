import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { Sidebar } from "@/components/sidebar";
import { VerificationProvider } from "@/components/verification";
import { PUBLIC_ORIGIN } from "@/lib/public-discovery";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Romanum", template: "%s · Romanum" },
  metadataBase: new URL(PUBLIC_ORIGIN),
  description: "Public Roblox game statistics, chart samples and grounded game research. Free analytics and read-only MCP.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geist.variable} h-full antialiased`}>
      <body className="min-h-full">
        <a href="#main-content" className="sr-only z-50 rounded-lg bg-fg px-4 py-3 text-sm text-canvas focus:not-sr-only focus:fixed focus:top-[calc(env(safe-area-inset-top)+0.75rem)] focus:left-4 md:focus:left-20">Skip to content</a>
        <VerificationProvider>
          <Sidebar />
          <main id="main-content" tabIndex={-1} className="pt-(--mobile-nav-height) outline-none md:pl-16">
            {/* Wide enough for dashboards on large screens; reading text constrains its own width. */}
            <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-8 sm:py-8 xl:px-12">{children}</div>
          </main>
        </VerificationProvider>
      </body>
    </html>
  );
}
