import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "ChaiCode AI Assistant | RAG Bot",
  description: "Ask anything in Hinglish, backed by Hitesh Sir's YouTube video timestamps.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${jakarta.variable} font-sans h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col font-sans bg-[#09090b] text-zinc-100">{children}</body>
    </html>
  );
}
