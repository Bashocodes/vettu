/**
 * VETTU faces (DESIGN §2f) via next/font/google — never a copied blob.
 * - Archivo Black: 400 only (the board's 700 requests are a synthetic bold on purpose).
 * - Syncopate: 700 only (row numbers + the VETTU wordmark).
 * - JetBrains Mono: board badges.
 * The serif (Charter → Iowan Old Style → Georgia) and the body sans are system stacks, never bundled.
 * Add `fontVariables` to `<html className>` in app/layout.tsx.
 */
import { Archivo_Black, JetBrains_Mono, Syncopate } from "next/font/google";

const archivoBlack = Archivo_Black({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
  variable: "--v-font-archivo",
  fallback: ["Helvetica", "Arial", "sans-serif"],
});

const syncopate = Syncopate({
  weight: "700",
  subsets: ["latin"],
  display: "swap",
  variable: "--v-font-syncopate",
  fallback: ["Helvetica", "Arial", "sans-serif"],
});

const jetbrainsMono = JetBrains_Mono({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--v-font-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});

export const fontVariables = [archivoBlack.variable, syncopate.variable, jetbrainsMono.variable].join(" ");
