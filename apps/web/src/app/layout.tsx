import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import { fontVariables } from "@/lib/fonts";
import "@copilotkit/react-core/v2/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "THE FILM BOARD — VETTU",
  description: "VETTU — an agentic film board for any film. Say the cut. Agents make it.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={fontVariables}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
