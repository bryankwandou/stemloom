import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { OfflineReady } from "@/components/OfflineReady";

// next/font self-hosts these at build time, so the running app never
// reaches out to a font CDN. That matters for an editor that promises to
// work with the network switched off.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono-jet",
  display: "swap",
});

const DESCRIPTION =
  "A multitrack audio editor that runs entirely in your browser. Your files are decoded, edited, and rendered on your own machine — nothing is uploaded, nothing is watermarked, and every effect is unlocked.";

export const metadata: Metadata = {
  metadataBase: new URL("https://stemloom.vercel.app"),
  title: {
    default: "Stemloom — Audio editing that never leaves your machine",
    template: "%s · Stemloom",
  },
  description: DESCRIPTION,
  keywords: [
    "audio editor",
    "browser DAW",
    "offline audio editing",
    "multitrack editor",
    "waveform editor",
    "Web Audio",
    "no watermark",
  ],
  authors: [{ name: "Stemloom" }],
  openGraph: {
    title: "Stemloom",
    description: DESCRIPTION,
    type: "website",
    siteName: "Stemloom",
  },
  twitter: {
    card: "summary_large_image",
    title: "Stemloom",
    description: DESCRIPTION,
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#08090a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="antialiased">
        {children}
        <OfflineReady />
      </body>
    </html>
  );
}
