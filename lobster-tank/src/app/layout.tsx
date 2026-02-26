import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SolanaProviders } from "@/components/SolanaProviders";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Lobster Tank",
  description: "AI-managed aquarium and lobster simulation",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        <SolanaProviders>{children}</SolanaProviders>
      </body>
    </html>
  );
}
