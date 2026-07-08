import type { CarEntry } from "../store/types";

/** iRating-seeded positions used before the sim publishes live standings. */
export function buildProvisionalPositions(cars: CarEntry[]) {
  const rated = cars.filter((c) => c.irating != null);
  const provPos = new Map<number, number>();
  [...rated]
    .sort((a, b) => (b.irating ?? 0) - (a.irating ?? 0))
    .forEach((c, i) => provPos.set(c.carIdx, i + 1));
  const provClassPos = new Map<number, number>();
  const byClass = new Map<number, CarEntry[]>();
  for (const c of rated) {
    const k = c.carClassId ?? 0;
    let g = byClass.get(k);
    if (!g) {
      g = [];
      byClass.set(k, g);
    }
    g.push(c);
  }
  for (const g of byClass.values()) {
    g.sort((a, b) => (b.irating ?? 0) - (a.irating ?? 0));
    g.forEach((c, i) => provClassPos.set(c.carIdx, i + 1));
  }
  return { provPos, provClassPos };
}

/** Sort key for standings rows — real sim position first, then provisional. */
export function standingSortKey(
  c: CarEntry,
  multiclass: boolean,
  provPos: Map<number, number>,
  provClassPos: Map<number, number>,
): number {
  if (multiclass) {
    const real = c.classPosition ?? c.position;
    if (real != null) return real;
    return provClassPos.get(c.carIdx) ?? provPos.get(c.carIdx) ?? 999;
  }
  const real = c.position ?? c.classPosition;
  if (real != null) return real;
  return provPos.get(c.carIdx) ?? 999;
}

export function standingPosOf(
  c: CarEntry,
  multiclass: boolean,
  provPos: Map<number, number>,
  provClassPos: Map<number, number>,
): { pos: number | null; provisional: boolean } {
  const real = multiclass ? (c.classPosition ?? c.position) : (c.position ?? c.classPosition);
  if (real != null) return { pos: real, provisional: false };
  const prov = multiclass
    ? (provClassPos.get(c.carIdx) ?? provPos.get(c.carIdx) ?? null)
    : (provPos.get(c.carIdx) ?? null);
  return { pos: prov, provisional: prov != null };
}

/** Relative widget: class-first, then overall, then provisional. */
export function relativePosOf(
  c: CarEntry,
  provPos: Map<number, number>,
  provClassPos: Map<number, number>,
): { pos: number | null; provisional: boolean } {
  const real = c.classPosition ?? c.position;
  if (real != null) return { pos: real, provisional: false };
  const prov = provClassPos.get(c.carIdx) ?? provPos.get(c.carIdx) ?? null;
  return { pos: prov, provisional: prov != null };
}
