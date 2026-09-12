"use client";

/**
 * The VETTU mark (dark): board, blade, pivot and the word, drawn inline. The intro plays once per page
 * load and rests on the still mark; later client navigations render the still mark straight away.
 * Reduced motion → the still mark only. The box is fixed so nothing beside it ever moves.
 */
import { useEffect, useId, useState } from "react";
import "./vettu-mark.css";

let introPlayed = false;

export function VettuMark({ className }: { className?: string }) {
  const [intro] = useState(() => typeof window === "undefined" || !introPlayed);
  const maskId = `vm-m-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    introPlayed = true;
  }, []);

  return (
    <span className={`vm-logo${intro ? " intro" : ""}${className ? ` ${className}` : ""}`}>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="VETTU">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
            <rect width="512" height="512" fill="#fff" />
            <circle cx="97.25" cy="261.8" r="18" fill="#000" />
          </mask>
        </defs>
        <g className="vm-mark">
          <g mask={`url(#${maskId})`} fill="none" strokeWidth="9" strokeLinejoin="round" strokeLinecap="round">
            <path
              className="vm-board"
              d="M97.25 273.8H437.25V383.8A14 14 0 0 1 423.25 397.8H111.25A14 14 0 0 1 97.25 383.8Z"
              stroke="#EFE9DF"
              pathLength={1}
            />
            <g className="vm-blade">
              <path
                className="vm-edge"
                d="M97.25 273.8L97.25 249.8L137.25 225.8L267.25 225.8C343.75 225.8 386.25 257 437.25 273.8Z"
                stroke="#35d492"
                pathLength={1}
              />
            </g>
          </g>
          <g transform="translate(137.19 306.8)">
            <g className="vm-word" fill="#EFE9DF">
              <g className="vm-grow">
                <path d="M0 0L17.65 0L30.74 34.44L43.83 0L61.48 0L39.44 58L22.04 58ZM66.12 0L82.62 0L82.62 58L66.12 58ZM66.12 0L102.66 0L102.66 14.5L66.12 14.5ZM66.12 20.59L99.18 20.59L99.18 35.09L66.12 35.09ZM66.12 43.5L102.66 43.5L102.66 58L66.12 58ZM109.04 0L153.12 0L153.12 14.5L109.04 14.5ZM122.83 0L139.33 0L139.33 58L122.83 58ZM158.05 0L202.13 0L202.13 14.5L158.05 14.5ZM171.84 0L188.34 0L188.34 58L171.84 58ZM207.93 0H224.43V31.9A9.6 9.6 0 0 0 243.63 31.9V0H260.13V31.9A26.1 26.1 0 0 1 207.93 31.9Z" />
              </g>
            </g>
          </g>
          <g className="vm-pivot">
            <circle cx="97.25" cy="261.8" r="22.5" fill="none" stroke="#EFE9DF" strokeWidth="9" />
            <circle cx="97.25" cy="261.8" r="5.5" fill="#35d492" />
          </g>
          <g className="vm-ticks" fill="none" stroke="#35d492" strokeWidth="7.2" strokeLinecap="round" opacity="0">
            <path d="M440.81 257.08L443.99 242.11" />
            <path d="M449.55 261.93L460.56 251.3" />
            <path d="M454.09 270.83L469.16 268.18" />
          </g>
        </g>
      </svg>
    </span>
  );
}
