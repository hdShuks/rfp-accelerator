import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RFP Accelerator",
  description:
    "Classify an RFP, run an orchestrated research pass over SEC EDGAR data, and draft a proposal skeleton.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
