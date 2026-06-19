// Browser-side synthetic source — a TS port of the Rust MockConnector, so the UI
// runs in a plain browser (and on macOS) with no sim and no Tauri backend.
// Provides a believable hot lap plus a 3-class field with rich per-car data
// (number, country, license, iRating, tyre, …) for the standings/relative widgets.

import { store, type TelemetryStore } from "./store";
import type { CarEntry, FastSample, SlowSample } from "./types";

const TAU = Math.PI * 2;
const LAP_SECONDS = 90;
const FAST_HZ = 60;
const SLOW_HZ = 5;
const PLAYER_IDX = 4;

const GTP = 0x20d6b0;
const GT3 = 0x3d8bff;
const GT4 = 0xb06bff;

/** Track centerline (normalized 0..1, y down), closed loop, index 0 on the
 * start/finish line. Real Watkins Glen International outline (iRacing track id
 * 433), downsampled from the bundled map so the browser preview shows a real
 * circuit — mirrors the Rust mock. */
const TRACK_PATH: [number, number][] = [
  [0.2412, 0.7575], [0.2153, 0.7575], [0.1897, 0.7575], [0.1633, 0.7576], [0.1375, 0.7577], [0.1116, 0.7577],
  [0.0856, 0.7578], [0.0597, 0.7579], [0.0337, 0.7576], [0.0102, 0.7479], [0.0003, 0.7246], [0.0017, 0.6987],
  [0.0049, 0.673], [0.0081, 0.6471], [0.0113, 0.6214], [0.0144, 0.5958], [0.0175, 0.57], [0.0232, 0.5447],
  [0.0346, 0.5215], [0.0513, 0.5018], [0.0724, 0.4867], [0.0964, 0.4769], [0.1218, 0.4718], [0.1473, 0.467],
  [0.1715, 0.4579], [0.1938, 0.4446], [0.213, 0.4273], [0.2297, 0.4073], [0.2454, 0.3869], [0.2621, 0.3668],
  [0.2806, 0.3489], [0.3015, 0.3333], [0.3239, 0.3202], [0.3473, 0.3092], [0.372, 0.3014], [0.3975, 0.2965],
  [0.4231, 0.2932], [0.4488, 0.2903], [0.4749, 0.2876], [0.5008, 0.2849], [0.5264, 0.2823], [0.5524, 0.2797],
  [0.5779, 0.2771], [0.604, 0.2745], [0.6297, 0.2719], [0.6554, 0.2693], [0.6813, 0.2667], [0.7071, 0.2641],
  [0.7329, 0.2614], [0.7587, 0.2602], [0.776, 0.2782], [0.8018, 0.2768], [0.8258, 0.2689], [0.8435, 0.2507],
  [0.8689, 0.2459], [0.8947, 0.2434], [0.9205, 0.2423], [0.9459, 0.2477], [0.9688, 0.2596], [0.9869, 0.278],
  [0.9974, 0.3016], [0.9999, 0.3274], [0.9951, 0.3528], [0.9833, 0.3756], [0.964, 0.3931], [0.9402, 0.4031],
  [0.9158, 0.4113], [0.8911, 0.4192], [0.8662, 0.427], [0.8414, 0.4345], [0.8165, 0.442], [0.7915, 0.4495],
  [0.7668, 0.4568], [0.7419, 0.4642], [0.717, 0.4717], [0.6922, 0.4792], [0.6673, 0.4867], [0.6426, 0.4942],
  [0.6176, 0.5019], [0.5931, 0.5095], [0.5681, 0.5173], [0.5438, 0.526], [0.5243, 0.5427], [0.5155, 0.5669],
  [0.5157, 0.5927], [0.5161, 0.6186], [0.5163, 0.6446], [0.5163, 0.6706], [0.5161, 0.6965], [0.5122, 0.722],
  [0.4975, 0.743], [0.4745, 0.7546], [0.4489, 0.7579], [0.4227, 0.7578], [0.397, 0.7576], [0.371, 0.7575],
  [0.3453, 0.7575], [0.3189, 0.7574], [0.2934, 0.7574], [0.2673, 0.7574],
];

/** Corner labels for the mock track, in the same normalized space as TRACK_PATH. */
const TRACK_TURNS: { label: string; x: number; y: number }[] = [
  { label: "1", x: -0.00523, y: 0.76574 }, { label: "2", x: 0.06541, y: 0.52983 },
  { label: "3", x: 0.17027, y: 0.4451 }, { label: "4", x: 0.16718, y: 0.40109 },
  { label: "5", x: 0.31577, y: 0.36065 }, { label: "6", x: 0.70924, y: 0.24639 },
  { label: "7", x: 1.00829, y: 0.28764 }, { label: "8", x: 0.96174, y: 0.30897 },
  { label: "9", x: 0.5362, y: 0.55933 }, { label: "10", x: 0.47234, y: 0.72853 },
];

interface MockCar {
  carIdx: number;
  name: string;
  number: string;
  country: string;
  classId: number;
  className: string;
  classColor: number;
  /** Car model name (so the manufacturer-icon mapping has something to match). */
  car: string;
  license: string; // "A 3.99"
  irating: number;
  iratingDelta: number;
  positionsGained: number;
  tyre: string;
  bestLapS: number;
  basePos: number;
  baseGap: number; // steady-state gap to player (s)
}

const FIELD: MockCar[] = [
  { carIdx: 0, name: "M. Rossi", number: "92", country: "FR", classId: 1, className: "GTP", classColor: GTP, car: "Cadillac V-Series.R GTP", license: "P 4.8", irating: 8200, iratingDelta: 12, positionsGained: 1, tyre: "S", bestLapS: 105.5, basePos: 1, baseGap: 6.2 },
  { carIdx: 1, name: "K. Tanaka", number: "6", country: "JP", classId: 1, className: "GTP", classColor: GTP, car: "Porsche 963 GTP", license: "A 3.9", irating: 6500, iratingDelta: -8, positionsGained: -1, tyre: "M", bestLapS: 105.8, basePos: 2, baseGap: 3.9 },
  { carIdx: 2, name: "L. Becker", number: "51", country: "DE", classId: 1, className: "GTP", classColor: GTP, car: "BMW M Hybrid V8", license: "P 4.2", irating: 7800, iratingDelta: 5, positionsGained: 0, tyre: "M", bestLapS: 106.0, basePos: 3, baseGap: 2.1 },
  { carIdx: 3, name: "S. Dubois", number: "71", country: "GB", classId: 2, className: "GT3", classColor: GT3, car: "Ferrari 296 GT3", license: "B 3.8", irating: 6100, iratingDelta: 9, positionsGained: 2, tyre: "S", bestLapS: 106.4, basePos: 4, baseGap: 0.9 },
  { carIdx: PLAYER_IDX, name: "You", number: "4", country: "US", classId: 2, className: "GT3", classColor: GT3, car: "BMW M4 GT3 EVO", license: "A 3.3", irating: 3300, iratingDelta: -3, positionsGained: 1, tyre: "M", bestLapS: 106.6, basePos: 5, baseGap: 0.0 },
  { carIdx: 5, name: "A. Novak", number: "44", country: "DE", classId: 2, className: "GT3", classColor: GT3, car: "McLaren 720S GT3 EVO", license: "A 4.5", irating: 5800, iratingDelta: 18, positionsGained: 3, tyre: "H", bestLapS: 106.5, basePos: 6, baseGap: -1.4 },
  { carIdx: 6, name: "T. Olsen", number: "7", country: "SE", classId: 2, className: "GT3", classColor: GT3, car: "Mercedes-AMG GT3 2020", license: "C 1.8", irating: 2400, iratingDelta: -10, positionsGained: -2, tyre: "H", bestLapS: 106.1, basePos: 7, baseGap: -3.8 },
  { carIdx: 7, name: "M. Cairo", number: "22", country: "ES", classId: 2, className: "GT3", classColor: GT3, car: "Chevrolet Corvette Z06 GT3.R", license: "C 2.4", irating: 2800, iratingDelta: 32, positionsGained: 4, tyre: "M", bestLapS: 105.9, basePos: 8, baseGap: -5.6 },
  { carIdx: 8, name: "R. Mehta", number: "9", country: "GB", classId: 2, className: "GT3", classColor: GT3, car: "Ford Mustang GT3", license: "B 2.7", irating: 3200, iratingDelta: 6, positionsGained: 0, tyre: "M", bestLapS: 107.0, basePos: 9, baseGap: -7.9 },
  { carIdx: 9, name: "G. Fontana", number: "36", country: "IT", classId: 3, className: "LMP2", classColor: GT4, car: "Dallara P217", license: "B 3.4", irating: 3100, iratingDelta: 15, positionsGained: 2, tyre: "M", bestLapS: 110.4, basePos: 10, baseGap: -9.1 },
  { carIdx: 10, name: "H. Park", number: "10", country: "JP", classId: 3, className: "LMP2", classColor: GT4, car: "Dallara P217", license: "C 2.1", irating: 2200, iratingDelta: 8, positionsGained: 1, tyre: "H", bestLapS: 110.5, basePos: 11, baseGap: -12.7 },
  { carIdx: 11, name: "B. Costa", number: "59", country: "BR", classId: 3, className: "LMP2", classColor: GT4, car: "Dallara P217", license: "D 3.6", irating: 1500, iratingDelta: 42, positionsGained: 5, tyre: "W", bestLapS: 111.0, basePos: 12, baseGap: -15.3 },
  { carIdx: 12, name: "J. Webb", number: "88", country: "US", classId: 2, className: "GT3", classColor: GT3, car: "Audi R8 LMS GT3 EVO II", license: "R 1.49", irating: 850, iratingDelta: 61, positionsGained: -1, tyre: "M", bestLapS: 108.2, basePos: 13, baseGap: -18.5 },
];

function classPosition(car: MockCar): number {
  return FIELD.filter((c) => c.classId === car.classId && c.basePos <= car.basePos).length;
}

export function startBrowserMock(target: TelemetryStore = store): () => void {
  target.setCaps({
    clutch: true,
    steeringAngle: true,
    fuel: true,
    deltas: true,
    relativeGaps: true,
    irating: true,
    safetyRating: true,
    multiclass: true,
    proximity: true,
    trackMap: true,
    raceControl: true,
    chat: true,
    weather: true,
    sectors: true,
    carSetup: true,
    spectator: true,
    pitInfo: true,
  });

  const start = performance.now();
  let lap = 0;
  let prevPct = 0;
  let bestLap: number | null = null;
  let tick = 0;
  let fastInWindow = 0;
  let lastRateAt = start;
  let readerHz = FAST_HZ;

  const fastTimer = window.setInterval(() => {
    const t = (performance.now() - start) / 1000;
    const pct = (t % LAP_SECONDS) / LAP_SECONDS;
    if (pct < prevPct) {
      lap += 1;
      const lapTime = LAP_SECONDS + Math.sin(lap * 0.137) * 0.8;
      bestLap = bestLap === null ? lapTime : Math.min(bestLap, lapTime);
    }
    prevPct = pct;

    const corner = Math.sin(pct * TAU * 5);
    const throttle = clamp01(0.5 + 0.5 * corner);
    const brake = clamp01(Math.max(-corner - 0.3, 0));
    const speed = 30 + 45 * throttle;
    const gear = speed < 35 ? 2 : speed < 45 ? 3 : speed < 55 ? 4 : speed < 65 ? 5 : 6;
    const rpm = 4000 + 4500 * (0.3 + 0.7 * throttle) * (0.6 + 0.4 * Math.abs(corner));
    const steering = 0.6 * Math.sin(pct * TAU * 5 + 0.4);

    fastInWindow += 1;
    const now = performance.now();
    if (now - lastRateAt >= 1000) {
      readerHz = (fastInWindow * 1000) / (now - lastRateAt);
      fastInWindow = 0;
      lastRateAt = now;
    }

    tick += 1;
    target.ingestFast({
      ts: t,
      tick,
      readerHz,
      speedMs: speed,
      rpm,
      gear,
      throttle,
      brake,
      clutch: 0,
      steeringRad: steering,
      lapDistPct: pct,
      currentLapS: t % LAP_SECONDS,
      brakeBiasPct: 0.56,
      absActive: brake > 0.8,
      tcActive: false,
    } satisfies FastSample);
  }, 1000 / FAST_HZ);

  const slowTimer = window.setInterval(() => {
    const t = (performance.now() - start) / 1000;
    const pct = (t % LAP_SECONDS) / LAP_SECONDS;
    const delta = 0.4 * Math.sin(t * 0.7);
    const corner = Math.sin(pct * TAU * 5);
    const brake = clamp01(Math.max(-corner - 0.3, 0));

    const cars: CarEntry[] = FIELD.map((c) => {
      const wobble = 0.6 * Math.sin(t * 0.3 + c.carIdx);
      const gap = c.carIdx === PLAYER_IDX ? 0 : c.baseGap + wobble;

      // Radar: place the two nearest cars in left/right lanes weaving past the
      // player; everyone else sits off-radar at a coarse gap-derived distance.
      const near = c.carIdx === 3 || c.carIdx === 5;
      let relLatM: number | null = null;
      let relLonM: number | null = null;
      if (c.carIdx !== PLAYER_IDX) {
        if (near) {
          relLonM = 12 * Math.sin(t * 0.5 + c.carIdx);
          relLatM = (c.carIdx === 3 ? 1 : -1) * 2.1;
        } else {
          relLonM = Math.max(-240, Math.min(240, gap * 42));
          relLatM = 0;
        }
      }

      return {
        carIdx: c.carIdx,
        driverName: c.name,
        carScreenName: c.car,
        carClassId: c.classId,
        classColor: c.classColor,
        carClassName: c.className,
        position: c.basePos,
        classPosition: classPosition(c),
        lap,
        lapDistPct: ((t / LAP_SECONDS) % 1 + gap / LAP_SECONDS + 1) % 1,
        gapToPlayerS: gap,
        lastLapS: c.bestLapS + 0.4 + 0.6 * Math.abs(Math.sin(t * 0.2 + c.carIdx)),
        bestLapS: c.bestLapS,
        onPitRoad: false,
        irating: c.irating,
        safetyRating: c.license,
        isPlayer: c.carIdx === PLAYER_IDX,
        carNumber: c.number,
        country: c.country,
        positionsGained: c.positionsGained,
        iratingDelta: c.iratingDelta,
        tyre: c.tyre,
        relLatM,
        relLonM,
        pitStatus: 0,
        hasSessionFastest: c.carIdx === 0,
      };
    });

    const player = FIELD.find((c) => c.carIdx === PLAYER_IDX)!;
    const slow: SlowSample = {
      sim: "mock",
      trackName: "Watkins Glen International",
      sessionType: "Race",
      timeRemainingS: Math.max(1800 - t, 0),
      lapsRemaining: null,
      totalCars: FIELD.length,
      lap,
      position: player.basePos,
      classPosition: classPosition(player),
      lastLapS: bestLap,
      bestLapS: bestLap,
      currentLapS: t % LAP_SECONDS,
      deltaBestS: delta,
      deltaSessionBestS: delta + 0.1,
      fuelL: Math.max(60 - t * 0.02, 0),
      fuelPerLapL: 2.4,
      cars,
      playerCarIdx: PLAYER_IDX,
      spectatedCarIdx: PLAYER_IDX,
      carName: "Mock GT3",
      onTrack: true,
      inGarage: false,
      // Tie the screen-edge spotter glow to the two weaving "near" cars so it
      // agrees with the Radar/Spotter widgets: idx 5 is on the left (relLatM -2.1,
      // lon phase +5), idx 3 on the right (relLatM +2.1, lon phase +3).
      carLeft: Math.abs(12 * Math.sin(t * 0.5 + 5)) < 3,
      carRight: Math.abs(12 * Math.sin(t * 0.5 + 3)) < 3,
      trackPath: TRACK_PATH,
      trackTurns: TRACK_TURNS,
      trackMetadata: null,
      // Weather.
      flagsRaw: 0,
      airTempC: 22,
      trackTempC: 31,
      windSpeedMs: 3.5,
      windDirRad: 1.2,
      trackWetnessPct: 0,
      precipitationPct: 0,
      humidityPct: 0.55,
      // Race control + chat feeds.
      messages: [
        { timeS: t - 30, kind: "info", text: "Fastest lap #92 — 1:45.51", priority: 5 },
      ],
      chatMessages: [
        { user: "apex_andy", color: "#2fe08a", badge: null, text: "that overtake into 7 was clean", timeS: t - 12 },
        { user: "turn1_tina", color: "#37d4ea", badge: "MOD", text: "fuel's gonna be tight", timeS: t - 8 },
        { user: "slipstream_sam", color: "#ffb43d", badge: null, text: "P2 incoming let's go", timeS: t - 4 },
      ],
      // Pit info.
      pitSpeedLimitMs: 22.35,
      pitBoxDistM: null,
      // Sector times.
      sectorTimesS: {
        s1: (t % LAP_SECONDS) * 0.33,
        s2: pct > 0.33 ? (t % LAP_SECONDS) * 0.33 : null,
        s3: pct > 0.66 ? (t % LAP_SECONDS) * 0.34 : null,
      },
      sectorBestS: {
        s1: LAP_SECONDS * 0.33,
        s2: LAP_SECONDS * 0.33,
        s3: LAP_SECONDS * 0.34,
      },
      // In-car setup.
      brakeBiasPct: 0.56,
      absActive: brake > 0.8,
      tcActive: false,
      drsState: null,
      ersPct: null,
      fuelMix: null,
      p2pAvailable: null,
      tirePressures: { lfKpa: 127, rfKpa: 129, lrKpa: 122, rrKpa: 124 },
    };
    target.ingestSlow(slow);
  }, 1000 / SLOW_HZ);

  return () => {
    window.clearInterval(fastTimer);
    window.clearInterval(slowTimer);
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
