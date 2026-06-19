// Manufacturer badges for the standings / relative rows. The SVGs are
// single-path brand silhouettes (simple-icons style) with brand fill colors —
// but several are black or dark navy, which vanish on the dark rows. So we
// render them monochrome via CSS mask, tinted to the row's text color: always
// legible, consistent with the widgets' text-toned look, silhouette intact.
//
// Mapping is keyword-based against the sim's car model name (`carScreenName`).
// iRacing model names usually carry the make ("BMW M4 GT3", "Porsche 963"), so a
// substring match is reliable; unmatched cars fall back to an iRacing badge.

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

/** Resolve a car model name to a manufacturer icon URL, falling back to iRacing. */
export function carIconFor(name: string | null | undefined): string {
  if (!name) return iracing;
  const s = name.toLowerCase();
  for (const b of BRANDS) {
    if (b.keywords.some((k) => s.includes(k))) return b.icon;
  }
  return iracing;
}

// Wide, low-profile logos (wordmarks, the Chevy bowtie, the Ford oval) fit to
// the box *width* under `contain`, so in a square box they end up short and read
// small next to the round badges. We render those in a wider box (same height,
// so rows aren't disturbed) — the icon then scales up and overflows symmetrically
// into the column gap. The number is the width multiple of the square size.
const WIDTH_SCALE: Record<string, number> = {
  [chevrolet]: 1.7,
  [ford]: 1.6,
  [dallara]: 1.9,
  [mclaren]: 1.4,
  [kia]: 1.55,
  [superFormulaLights]: 1.8,
  [iracing]: 1.7,
};

// The wide, low-profile logos. They read small at the round-badge size, so the
// widgets render them one size tier larger (see each widget's icon cell).
const WIDE = new Set<string>([chevrolet, ford, dallara, mclaren, kia, superFormulaLights, iracing]);
export function isWideIcon(src: string): boolean {
  return WIDE.has(src);
}

/** The McLaren badge URL, exported so a widget can size it on its own. */
export const mclarenIcon = mclaren;

/** A monochrome manufacturer badge, masked and tinted to `color`. */
export function CarIcon({ src, color, size = "1.5em" }: { src: string; color: string; size?: string }) {
  const k = WIDTH_SCALE[src] ?? 1;
  const m = /^([\d.]+)(\D*)$/.exec(size);
  const n = m ? parseFloat(m[1]) : 1.5;
  const unit = (m && m[2]) || "em";
  const width = `${(n * k).toFixed(3)}${unit}`;
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        width,
        height: size,
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
