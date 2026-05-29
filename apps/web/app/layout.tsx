import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bir Dashboard",
  description: "Local trace dashboard for Bir",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
