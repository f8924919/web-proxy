import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Web Proxy",
  description: "ブラウザからターゲットサイトにアクセスできるウェブプロキシ",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
