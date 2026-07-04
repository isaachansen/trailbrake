// Manufacturer badges for the standings / relative rows. The SVGs are
// single-path brand silhouettes (simple-icons style) with brand fill colors —
// but several are black or dark navy, which vanish on the dark rows. So we
// render them monochrome via CSS mask, tinted to the row's text color: always
// legible, consistent with the widgets' text-toned look, silhouette intact.
//
// Mapping is keyword-based against the sim's car model name (`carScreenName`).
// iRacing model names usually carry the make ("BMW M4 GT3", "Porsche 963"), so a
// substring match is reliable. Unknown cars resolve to null so callers can tell
// "no icon" apart from a match; `iracingIcon` is exported for callers that want
// an explicit generic fallback badge.

import acura from "../../assets/car_icons/acura.svg";
import amg from "../../assets/car_icons/amg.svg";
import astonmartin from "../../assets/car_icons/astonmartin.svg";
import audi from "../../assets/car_icons/audi.svg";
import bmw from "../../assets/car_icons/bmw.svg";
import cadillac from "../../assets/car_icons/cadillac.svg";
import dallara from "../../assets/car_icons/dallara.svg";
import chevrolet from "../../assets/car_icons/chevrolet.svg";
import ferrari from "../../assets/car_icons/ferrari.svg";
import ford from "../../assets/car_icons/ford.svg";
import honda from "../../assets/car_icons/honda.svg";
import hyundai from "../../assets/car_icons/hyundai.svg";
import iracing from "../../assets/car_icons/iracing.svg";
import kia from "../../assets/car_icons/kia.svg";
import lamborghini from "../../assets/car_icons/lamborghini.svg";
import lexus from "../../assets/car_icons/lexus.svg";
import mazda from "../../assets/car_icons/mazda.svg";
import mclaren from "../../assets/car_icons/mclaren.svg";
import nissan from "../../assets/car_icons/nissan.svg";
import pontiac from "../../assets/car_icons/pontiac.svg";
import porsche from "../../assets/car_icons/porsche.svg";
import radical from "../../assets/car_icons/radical.svg";
import renault from "../../assets/car_icons/renault.svg";
import subaru from "../../assets/car_icons/subaru.svg";
import superFormula from "../../assets/car_icons/super-formula.svg";
import superFormulaLights from "../../assets/car_icons/super-formula-lights.svg";
import toyota from "../../assets/car_icons/toyota.svg";
import volkswagen from "../../assets/car_icons/volkswagen.svg";

interface Brand {
  icon: string;
  /** Lowercase substrings to look for in the car model name. */
  keywords: string[];
}

// Order matters only for overlaps; the lists are kept specific to avoid them.
const BRANDS: Brand[] = [
  { icon: bmw, keywords: ["bmw"] },
  { icon: amg, keywords: ["mercedes", "amg"] },
  { icon: ferrari, keywords: ["ferrari"] },
  { icon: porsche, keywords: ["porsche"] },
  { icon: audi, keywords: ["audi"] },
  { icon: mclaren, keywords: ["mclaren"] },
  { icon: lamborghini, keywords: ["lamborghini", "huracan", "huracán"] },
  { icon: acura, keywords: ["acura"] },
  { icon: cadillac, keywords: ["cadillac"] },
  { icon: chevrolet, keywords: ["chevrolet", "chevy", "corvette", "camaro"] },
  { icon: ford, keywords: ["ford", "mustang"] },
  { icon: honda, keywords: ["honda", "civic"] },
  { icon: hyundai, keywords: ["hyundai", "elantra", "veloster"] },
  { icon: kia, keywords: ["kia", "optima"] },
  { icon: lexus, keywords: ["lexus", "rc f", "rc-f", "rcf"] },
  { icon: mazda, keywords: ["mazda", "mx-5", "mx5", "miata"] },
  { icon: nissan, keywords: ["nissan", "gt-r", "gtr", "skyline", "370z", "350z"] },
  { icon: pontiac, keywords: ["pontiac", "solstice"] },
  { icon: radical, keywords: ["radical", "sr8", "sr10"] },
  { icon: renault, keywords: ["renault"] },
  { icon: subaru, keywords: ["subaru", "wrx"] },
  { icon: toyota, keywords: ["toyota", "supra", "gr86", "gr 86", "gr010", "camry"] },
  { icon: volkswagen, keywords: ["volkswagen", "vw", "jetta", "beetle"] },
  { icon: superFormulaLights, keywords: ["super formula lights", "superformula lights", "dallara 324", "f324"] },
  { icon: superFormula, keywords: ["super formula", "superformula", "sf23", "sf19"] },
  { icon: astonmartin, keywords: ["aston", "vantage"] },
  { icon: dallara, keywords: ["dallara"] }, // P217, iR-01/iR18, F3, DW12 — chassis maker
];

/** Resolve a car model name to a manufacturer icon URL, or null when unknown. */
export function carIconFor(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = name.toLowerCase();
  for (const b of BRANDS) {
    if (b.keywords.some((k) => s.includes(k))) return b.icon;
  }
  return null;
}

/** Generic iRacing badge — the explicit fallback for cars with no brand match. */
export const iracingIcon = iracing;

// Equal-visual-weight calibration. `mask-size: contain` fits each SVG's own
// viewBox into its box, so two icons at the identical box size can read very
// differently: round/square badges (BMW, Mercedes) fill their box on every
// side, but a horizontal wordmark crammed into a square viewBox (Aston
// Martin, Audi) or a wide, tightly-cropped logo (Chevy bowtie, Ford oval,
// McLaren swoosh) end up small and thin at the same nominal size. The goal
// here is not equal box geometry — it's equal *perceived* size: wordmarks and
// low, wide marks get a wider box (bleeds symmetrically into the column gap,
// same as before) and, for icons padded inside a square canvas, a taller box
// too (capped so a row never clips). `w`/`h` are multipliers on the caller's
// base `size`; omitted icons default to `{ w: 1, h: 1 }`.
const ICON_CAL: Record<string, { w: number; h: number }> = {
  [astonmartin]: { w: 1.15, h: 1.15 },
  [audi]: { w: 1.15, h: 1.15 },
  [cadillac]: { w: 1.15, h: 1.15 },
  [dallara]: { w: 1.3, h: 1 },
  [chevrolet]: { w: 1.85, h: 1 },
  [ferrari]: { w: 1.15, h: 1.15 },
  [ford]: { w: 1.8, h: 1 },
  [iracing]: { w: 1.35, h: 1 },
  [kia]: { w: 1.5, h: 1 },
  [lamborghini]: { w: 1.15, h: 1.15 },
  [lexus]: { w: 1.1, h: 1 },
  [mclaren]: { w: 1.6, h: 1.1 },
  [pontiac]: { w: 1, h: 1.05 },
  [porsche]: { w: 1.15, h: 1.15 },
  [radical]: { w: 1.1, h: 1 },
  [renault]: { w: 1.05, h: 1.05 },
  [superFormula]: { w: 1.1, h: 1.05 },
  [superFormulaLights]: { w: 1.8, h: 1 },
};

/** A monochrome manufacturer badge, masked and tinted to `color`. */
export function CarIcon({ src, color, size = "1.5em" }: { src: string; color: string; size?: string }) {
  const cal = ICON_CAL[src] ?? { w: 1, h: 1 };
  const m = /^([\d.]+)(\D*)$/.exec(size);
  const n = m ? parseFloat(m[1]) : 1.5;
  const unit = (m && m[2]) || "em";
  const width = `${(n * cal.w).toFixed(3)}${unit}`;
  const height = `${(n * cal.h).toFixed(3)}${unit}`;
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        width,
        height,
        background: color,
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}
