// A dedicated telemetry store for the manager's widget previews, fed by the
// browser mock. Kept separate from the global store so previews always show
// believable data regardless of the real source — and without overwriting the
// real car/session data the manager uses elsewhere.

import { TelemetryStore } from "../store/store";
import { startBrowserMock } from "../store/mockSource";
import type { CarEntry, FastSample, SlowSample } from "../store/types";

const TAU = Math.PI * 2;

export const previewStore = new TelemetryStore();

// Some widgets only render in a specific situation the hot-lap mock never enters
// (e.g. the rejoin indicator only appears when you're slow/off track). Those get
// a dedicated scenario store so their preview actually shows the widget at work,
// without changing how it behaves on the real overlay. The stores are created
// eagerly so `previewStoreFor` returns the right one on the very first render —
// `startPreviewMock` just begins feeding them.
const scenarioStores: Record<string, TelemetryStore> = {
  "rejoin-indicator": new TelemetryStore(),
  "launch-assist": new TelemetryStore(),
};

/** The store a given widget's preview should read from — its scenario store if
 * it has one, otherwise the shared hot-lap store. */
export function previewStoreFor(id: string): TelemetryStore {
  return scenarioStores[id] ?? previewStore;
}

const PREVIEW_CAPS = {
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
} as const;

/** Feed the rejoin-indicator scenario: the player stopped just off the racing
 * line while a car closes from behind — the gap cycles through clear / caution /
 * do-not-rejoin so the preview demonstrates every state. */
function startRejoinScenario(target: TelemetryStore): () => void {
  target.setCaps({ ...PREVIEW_CAPS });
  const start = performance.now();
  let tick = 0;

  const blankCar = (carIdx: number, over: Partial<CarEntry>): CarEntry => ({
    carIdx,
    driverName: null,
    carScreenName: null,
    carClassId: 2,
    classColor: 0x3d8bff,
    carClassName: "GT3",
    position: null,
    classPosition: null,
    lap: 0,
    lapDistPct: 0,
    gapToPlayerS: null,
    lastLapS: null,
    bestLapS: null,
    onPitRoad: false,
    inWorld: true,
    irating: null,
    safetyRating: null,
    isPlayer: false,
    carNumber: null,
    country: null,
    positionsGained: null,
    iratingDelta: null,
    tyre: null,
    relLatM: null,
    relLonM: null,
    pitStatus: null,
    hasSessionFastest: null,
    ...over,
  });

  const fastTimer = window.setInterval(() => {
    const t = (performance.now() - start) / 1000;
    tick += 1;
    target.ingestFast({
      ts: t,
      tick,
      readerHz: 60,
      speedMs: 4, // crawling — below the widget's show-below threshold
      rpm: 3500,
      gear: 1,
      throttle: 0,
      brake: 0,
      clutch: 0.6,
      steeringRad: 0,
      lapDistPct: 0.42,
      currentLapS: t,
      brakeBiasPct: 0.56,
      absActive: false,
      tcActive: false,
      carLeft: null,
      carRight: null,
    } satisfies FastSample);
  }, 1000 / 30);

  const slowTimer = window.setInterval(() => {
    const t = (performance.now() - start) / 1000;
    // Triangle-ish gap behind, ~7s period: 0.7s (do not rejoin) → 4.2s (clear).
    const gap = 0.7 + 1.75 * (1 + Math.sin(t * (TAU / 7)));

    const cars: CarEntry[] = [
      blankCar(0, { driverName: "You", carNumber: "4", isPlayer: true, gapToPlayerS: 0, lapDistPct: 0.42 }),
      blankCar(5, { driverName: "A. Novak", carNumber: "44", gapToPlayerS: -gap, lapDistPct: 0.42 - gap / 90 }),
    ];

    target.ingestSlow({
      sim: "mock",
      trackName: "Watkins Glen International",
      sessionType: "Race",
      timeRemainingS: 1200,
      lapsRemaining: null,
      totalCars: cars.length,
      lap: 8,
      position: 5,
      classPosition: 2,
      lastLapS: null,
      bestLapS: 106.6,
      currentLapS: t,
      deltaBestS: null,
      deltaSessionBestS: null,
      fuelL: 40,
      fuelPerLapL: 2.4,
      cars,
      playerCarIdx: 0,
      spectatedCarIdx: 0,
      carName: "BMW M4 GT3 EVO",
      onTrack: true,
      inGarage: false,
      carLeft: null,
      carRight: null,
      trackPath: null,
      trackTurns: null,
      trackMetadata: null,
      flagsRaw: 0,
      airTempC: 22,
      trackTempC: 31,
      windSpeedMs: 3.5,
      windDirRad: 1.2,
      trackWetnessPct: 0,
      precipitationPct: 0,
      humidityPct: 0.55,
      messages: [],
      chatMessages: [],
      pitSpeedLimitMs: 22.35,
      pitBoxDistM: null,
      sectorTimesS: { s1: null, s2: null, s3: null },
      sectorBestS: { s1: null, s2: null, s3: null },
      brakeBiasPct: 0.56,
      absActive: false,
      tcActive: false,
      drsState: null,
      ersPct: null,
      fuelMix: null,
      p2pAvailable: null,
      tirePressures: { lfKpa: 127, rfKpa: 129, lrKpa: 122, rrKpa: 124 },
    } satisfies SlowSample);
  }, 1000 / 5);

  return () => {
    window.clearInterval(fastTimer);
    window.clearInterval(slowTimer);
  };
}

/** Feed the launch-assist scenario: a standing start staged and repeated on an
 * ~9s loop, so the preview mostly shows the ARMED (car stopped, full-opacity)
 * state the widget is built around, with a brief MOVING dip so both states are
 * visible. Phases (seconds into the loop):
 *   0.0–5.0  staging   — stopped, clutch/throttle blipped up toward their
 *                        targets while revving, as if finding the bite point.
 *   5.0–6.0  held      — stopped, clutch/throttle settled on-target (green).
 *   6.0–6.8  launch    — clutch dumped, throttle to the floor, speed climbs
 *                        past the widget's 2 m/s stopped threshold.
 *   6.8–8.5  driving   — brief acceleration away (MOVING, dimmed bars).
 *   8.5–9.0  stopping  — braking back down to a stop for the next rep. */
function startLaunchAssistScenario(target: TelemetryStore): () => void {
  target.setCaps({ ...PREVIEW_CAPS });
  const start = performance.now();
  const PERIOD = 9;
  let tick = 0;

  const fastTimer = window.setInterval(() => {
    const t = (performance.now() - start) / 1000;
    const p = t % PERIOD;
    tick += 1;

    let speed: number;
    let clutch: number;
    let throttle: number;
    let brake: number;
    let rpm: number;
    let gear: number;

    if (p < 5.0) {
      // Staging: blip the throttle and feel for the clutch bite while stopped.
      const k = p / 5.0;
      speed = 0;
      clutch = Math.min(0.6, k * 0.7);
      throttle = Math.max(0, 0.2 * Math.sin(p * TAU * 0.6)) * (0.3 + k);
      brake = 0.3;
      rpm = 1000 + 3200 * (0.3 + 0.7 * Math.abs(Math.sin(p * 0.9)));
      gear = 1;
    } else if (p < 6.0) {
      // Held on the bite point, on-target for both channels (bars flash green).
      speed = 0;
      clutch = 0.6;
      throttle = 0.5;
      brake = 0;
      rpm = 4200;
      gear = 1;
    } else if (p < 6.8) {
      // Launch: dump the clutch, bury the throttle.
      const k = (p - 6.0) / 0.8;
      speed = 10 * k;
      clutch = 0.6 * (1 - k);
      throttle = 0.5 + 0.5 * k;
      brake = 0;
      rpm = 4200 + 3300 * k;
      gear = 1;
    } else if (p < 8.5) {
      // Brief drive away — clearly moving, bars dimmed.
      const k = (p - 6.8) / 1.7;
      speed = 10 + 8 * k;
      clutch = 0;
      throttle = Math.max(0.3, 1 - 0.5 * k);
      brake = 0;
      rpm = 7500 - 2000 * k;
      gear = k > 0.5 ? 2 : 1;
    } else {
      // Braking back down to a stop for the next rep.
      const k = (p - 8.5) / 0.5;
      speed = Math.max(0, 18 * (1 - k));
      clutch = 0;
      throttle = 0;
      brake = 0.7;
      rpm = Math.max(1000, 5500 * (1 - k));
      gear = 1;
    }

    target.ingestFast({
      ts: t,
      tick,
      readerHz: 30,
      speedMs: speed,
      rpm,
      gear,
      throttle,
      brake,
      clutch,
      steeringRad: 0,
      lapDistPct: 0,
      currentLapS: t,
      brakeBiasPct: 0.56,
      absActive: false,
      tcActive: false,
      carLeft: null,
      carRight: null,
    } satisfies FastSample);
  }, 1000 / 30);

  return () => window.clearInterval(fastTimer);
}

/** Start feeding the preview store(s) with mock telemetry. Returns a stop function. */
export function startPreviewMock(): () => void {
  const stops = [
    startBrowserMock(previewStore),
    startRejoinScenario(scenarioStores["rejoin-indicator"]),
    startLaunchAssistScenario(scenarioStores["launch-assist"]),
  ];
  return () => stops.forEach((stop) => stop());
}
