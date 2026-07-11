import type { CarEntry } from "../store/types";

/**
 * Last-resort UI ranks when the connector left a car's positions null
 * (non-iRacing, or a partial field). Invents iRating order only for cars that
 * still have both sides empty, using ranks that do not collide with connector
 * values — inventing on top of a full live field is what created duplicate chips.
 */
export function buildProvisionalPositions(cars: CarEntry[]) {
  const provPos = new Map<number, number>();
  const provClassPos = new Map<number, number>();

  const need = cars.filter(
    (c) => c.position == null && c.classPosition == null && c.irating != null,
  );
  if (need.length === 0) return { provPos, provClassPos };

  const usedOverall = new Set<number>();
  const usedClass = new Map<number, Set<number>>();
  for (const c of cars) {
    if (c.position != null) usedOverall.add(c.position);
    if (c.classPosition != null) {
      const k = c.carClassId ?? 0;
      let set = usedClass.get(k);
      if (!set) {
        set = new Set();
        usedClass.set(k, set);
      }
      set.add(c.classPosition);
    }
  }

  const byIr = [...need].sort((a, b) => (b.irating ?? 0) - (a.irating ?? 0));
  let nextOverall = 1;
  for (const c of byIr) {
    while (usedOverall.has(nextOverall)) nextOverall += 1;
    provPos.set(c.carIdx, nextOverall);
    usedOverall.add(nextOverall);
    nextOverall += 1;

    const k = c.carClassId ?? 0;
    let set = usedClass.get(k);
    if (!set) {
      set = new Set();
      usedClass.set(k, set);
    }
    let nextClass = 1;
    while (set.has(nextClass)) nextClass += 1;
    provClassPos.set(c.carIdx, nextClass);
    set.add(nextClass);
  }

  return { provPos, provClassPos };
}

/** Sort key for standings rows — connector position first, then UI fallback. */
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
  // Prefer the dedicated field so we don't cross-fall into the other namespace
  // (that was the live-class-27 vs fallback-overall-27 duplicate).
  const real = multiclass ? c.classPosition : c.position;
  if (real != null) {
    return { pos: real, provisional: !!c.positionProvisional };
  }
  const fallback = multiclass ? c.position : c.classPosition;
  if (fallback != null) {
    return { pos: fallback, provisional: !!c.positionProvisional };
  }
  const prov = multiclass
    ? (provClassPos.get(c.carIdx) ?? provPos.get(c.carIdx) ?? null)
    : (provPos.get(c.carIdx) ?? null);
  return { pos: prov, provisional: prov != null };
}

/** Relative widget: class first, then overall, then UI fallback. */
export function relativePosOf(
  c: CarEntry,
  provPos: Map<number, number>,
  provClassPos: Map<number, number>,
): { pos: number | null; provisional: boolean } {
  if (c.classPosition != null) {
    return { pos: c.classPosition, provisional: !!c.positionProvisional };
  }
  if (c.position != null) {
    return { pos: c.position, provisional: !!c.positionProvisional };
  }
  const prov = provClassPos.get(c.carIdx) ?? provPos.get(c.carIdx) ?? null;
  return { pos: prov, provisional: prov != null };
}
