import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  fallback: ["PingFang SC", "Microsoft YaHei", "sans-serif"],
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Skillberry 工作台",
  description: "在项目中与 Agent 一起工作。",
  icons: { icon: "/skillberry.svg" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={`${inter.variable} ${geistMono.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
