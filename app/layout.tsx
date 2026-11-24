import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Skillberry 工作台",
  description: "在项目中与 Agent 一起工作。",
  icons: { icon: "/skillberry.svg" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
