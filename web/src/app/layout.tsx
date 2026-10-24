import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AccountBanner } from "@/components/AccountBanner";
import { Header } from "@/components/Header";
import { Providers } from "@/components/Providers";
import { ToastProvider } from "@/components/Toasts";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "perps.fun",
  description: "Social perpetuals trading: copy top traders, post chart theses, climb the leaderboard.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <Providers>
          <ToastProvider>
            <div className="flex h-screen flex-col">
              <Header />
              <AccountBanner />
              {children}
            </div>
          </ToastProvider>
        </Providers>
      </body>
    </html>
  );
}
