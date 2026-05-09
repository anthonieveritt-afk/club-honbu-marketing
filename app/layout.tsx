import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Club Honbu — Software for martial-arts clubs",
  description:
    "Built by an instructor, for instructors. Members, gradings, payments, and insights — all in one place.",
  metadataBase: new URL("https://clubhonbu.co.uk"),
  openGraph: {
    title: "Club Honbu",
    description: "Built by an instructor, for instructors.",
    url: "https://clubhonbu.co.uk",
    siteName: "Club Honbu",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
