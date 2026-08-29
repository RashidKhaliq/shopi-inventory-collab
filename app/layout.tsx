import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Shopify Inventory Sync Hub — Vercel Serverless',
  description: 'Production-ready multi-store Shopify inventory and B2B fulfillment order synchronization engine.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="bg-black text-white font-sans antialiased min-h-screen selection:bg-neutral-800">
        {children}
      </body>
    </html>
  );
}
