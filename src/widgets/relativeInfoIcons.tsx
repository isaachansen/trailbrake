// Line icons for the Relative widget's info-bar fields — drawn on a 24×24 grid
// with `currentColor` and a single stroke weight, so each info chip reads as an
// icon + value instead of a text label. Paths come from the "Relative Info Icons"
// design. Keyed by the widget's info-field keys (see INFO_FIELDS in Relative.tsx).

import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  // Conditions
  airTemp: (
    <>
      <path d="M10 13.4V6a2 2 0 1 1 4 0v7.4a3.5 3.5 0 1 1-4 0Z" />
      <circle cx="12" cy="16" r="1.6" fill="currentColor" stroke="none" />
      <path d="M14.2 8h1.6M14.2 11h1.6" />
    </>
  ),
  trackTemp: <path d="M7 20 10 4M17 20 14 4M12 17v-2M12 12v-2M12 7V6" />,
  brakeBias: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4.5v3M12 16.5v3M4.5 12h3M16.5 12h3" />
    </>
  ),
  // Session
  sessionType: <path d="M6 3v18M6 4h12l-3 3.5 3 3.5H6Z" />,
  track: (
    <>
      <path d="M12 21s7-6.4 7-11.5A7 7 0 1 0 5 9.5C5 14.6 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.6" />
    </>
  ),
  timeLeft: (
    <>
      <circle cx="12" cy="13.5" r="7" />
      <path d="M10 2.5h4M12 2.5v2.5M18.5 6.5l1.6-1.6M12 13.5V9.5" />
    </>
  ),
  lapsLeft: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M17.3 3.2v3.6h-3.6" />
    </>
  ),
  lap: (
    <>
      <path d="M5 12a7 7 0 1 0 7-7" />
      <circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none" />
      <path d="M12 9v3l2.5 1.6" />
    </>
  ),
  // Timing
  last: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  best: <path d="M12 3.5l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.3 6.9 19.2l1-5.7-4.1-4 5.7-.8Z" />,
  deltaBest: (
    <>
      <path d="M12 4.5 20 19H4Z" />
      <path d="M12 15.5v-4M10.2 13.2 12 11.4l1.8 1.8" />
    </>
  ),
  deltaSess: (
    <>
      <path d="M12 4.5 20 19H4Z" />
      <path d="M14.2 14.6a2.4 2.4 0 1 1-.8-1.8" />
      <path d="M13.5 11.4l.3 1.7-1.7.3" />
    </>
  ),
  // Fuel & position
  fuel: <path d="M4.5 20V5.5A1.5 1.5 0 0 1 6 4h5a1.5 1.5 0 0 1 1.5 1.5V20M3.5 20h10M6.5 8h4M6.5 11h4M12.5 9h2l2 2v6.3a1.5 1.5 0 0 0 3 0V8.6L17 6.6" />,
  fuelPerLap: (
    <>
      <path d="M11 3.5s5 5.4 5 8.8a5 5 0 0 1-7.7 4.2" />
      <path d="M6.5 9.2a5 5 0 0 0 1.8 7.3" />
      <path d="M8 17.8 6.3 17l.5 1.9" />
    </>
  ),
  position: (
    <>
      <path d="M8 4.5h8v3.5a4 4 0 0 1-8 0Z" />
      <path d="M8 5.5H5.8a2 2 0 0 0 2.4 3.2M16 5.5h2.2a2 2 0 0 1-2.4 3.2M12 11.5v3M9 17.5h6M10 14.5h4" />
    </>
  ),
  classPosition: (
    <>
      <path d="M13.4 4H19a1 1 0 0 1 1 1v5.6a1 1 0 0 1-.3.7l-8 8a1 1 0 0 1-1.4 0l-5.6-5.6a1 1 0 0 1 0-1.4l8-8a1 1 0 0 1 .7-.3Z" />
      <circle cx="16" cy="8" r="1.4" />
    </>
  ),
};

export function hasInfoIcon(key: string): boolean {
  return key in PATHS;
}

/** A single info-field line icon. Sizes in em so it scales with the info bar. */
export function InfoIcon({ name, size = "1.05em", strokeWidth = 1.8 }: { name: string; size?: string; strokeWidth?: number }) {
  const inner = PATHS[name];
  if (!inner) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ flex: "0 0 auto", display: "block" }}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {inner}
    </svg>
  );
}
