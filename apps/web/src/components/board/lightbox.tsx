"use client";

/** Full-screen image view (DESIGN §5). Esc closes and is taken before anything else on the page. */
import { useEffect } from "react";

export interface LightboxImage {
  src: string;
  alt: string;
}

export function Lightbox({ image, onClose }: { image: LightboxImage | null; onClose(): void }) {
  useEffect(() => {
    if (!image) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [image, onClose]);

  if (!image) return null;
  return (
    <div className="v-lbx" role="dialog" aria-modal="true" aria-label={image.alt || "image"} onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.src} alt={image.alt} />
      <span className="v-lbx-hint">esc close</span>
    </div>
  );
}
