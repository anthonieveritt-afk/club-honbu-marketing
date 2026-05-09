import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Club Honbu — Software for clubs that teach",
  description:
    "Built by instructors, for clubs. Members, attendance, progression, and payments — whether you run a dojo, a football squad, or anything in between.",
  metadataBase: new URL("https://clubhonbu.co.uk"),
  openGraph: {
    title: "Club Honbu",
    description: "Built by instructors, for clubs — martial arts and sports alike.",
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
