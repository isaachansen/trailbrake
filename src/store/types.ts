// Frontend mirror of the backend sample payloads. The Rust side serializes these
// with `rename_all = "camelCase"`, so field names match exactly.
//
// The fast/slow split is the whole point (perf non-negotiable #2): widgets
// subscribe only to the path they need. The Input graph is a *fast* widget; a
// standings widget would be *slow*.

export interface FastSample {
  /** Reader timestamp, seconds since reader start (monotonic). */
  ts: number;
  /** Monotonic snapshot counter. */
  tick: number;
  /** Measured reader poll rate (Hz), passed through for the perf HUD. */
  readerHz: number;

  speedMs: number | null;
  rpm: number | null;
  gear: number | null;
  throttle: number | null;
  brake: number | null;
  clutch: number | null;
  steeringRad: number | null;
  lapDistPct: number | null;
  /** Current lap time (seconds). */
  currentLapS: number | null;
  /** Brake bias fraction 0..1 (front bias). */
  brakeBiasPct: number | null;
  /** ABS active this frame. */
  absActive: boolean | null;
  /** Traction control active this frame. */
  tcActive: boolean | null;
  /** Spotter: a car is alongside on the left (iRacing CarLeftRight). */
  carLeft: boolean | null;
  /** Spotter: a car is alongside on the right (iRacing CarLeftRight). */
  carRight: boolean | null;
}

/** One car in the field. Mirrors overlay-core's `CarState`. */
export interface CarEntry {
  carIdx: number;
  driverName: string | null;
  /** Car model display name (e.g. "Dallara P217") — class-label fallback. */
  carScreenName: string | null;
  carClassId: number | null;
  /** Class color as a 0xRRGGBB integer (multiclass), if provided. */
  classColor: number | null;
  /** Short class name, e.g. "GT3" (for multiclass group headers). */
  carClassName: string | null;
  position: number | null;
  classPosition: number | null;
  lap: number | null;
  lapDistPct: number | null;
  /** Signed gap to the player in seconds (positive = ahead on track-time). */
  gapToPlayerS: number | null;
  lastLapS: number | null;
  bestLapS: number | null;
  onPitRoad: boolean | null;
  /**
   * Whether this car is loaded into the world (on track / in pits / off-track)
   * vs. absent from the session (garage, disconnected, not yet joined). `null`
   * when the sim doesn't distinguish. The Relative widget hides cars that are
   * not in the world so stale roster entries don't appear as phantom neighbours.
   */
  inWorld: boolean | null;
  irating: number | null;
  /** License string, e.g. "A 3.99" (letter + safety rating). */
  safetyRating: string | null;
  isPlayer: boolean;

  // Richer fields (mock provides; live sims fill what they can, else null).
  carNumber: string | null;
  /** 2-letter country code for the flag swatch. */
  country: string | null;
  /** Positions gained (+) / lost (−) since the start. */
  positionsGained: number | null;
  iratingDelta: number | null;
  /** Tyre compound letter: S / M / H / W. */
  tyre: string | null;

  // Proximity (radar). Position of this car *relative to the player*, in meters.
  // Lateral: +right / −left of the player. Longitudinal: +ahead / −behind.
  // Only sims that expose neighbouring-car world positions can fill these; when
  // absent the radar widget hides (capability `proximity`).
  relLatM: number | null;
  relLonM: number | null;
  /** Pit-stop status (sim-specific enum). iRacing CarIdxPitStopStatus. */
  pitStatus: number | null;
  /** True when this car holds the session fastest lap. */
  hasSessionFastest: boolean | null;
}

/** One race-control message (flag change, penalty, info, warning). */
export interface RaceControlMessage {
  timeS: number | null;
  kind: string;
  text: string;
  priority: number;
}

/** One chat message from a broadcast chat source. */
export interface ChatMessage {
  user: string;
  color: string | null;
  badge: string | null;
  text: string;
  timeS: number | null;
}

/** Per-sector times for one lap (3 sectors). */
export interface Sectors {
  s1: number | null;
  s2: number | null;
  s3: number | null;
}

/** Tire pressures for the four corners, in kPa. */
export interface TirePressures {
  lfKpa: number | null;
  rfKpa: number | null;
  lrKpa: number | null;
  rrKpa: number | null;
}

/** A sector boundary marker for track metadata. */
export interface TrackSector {
  name: string;
  /** Position as a fraction 0..1 of lap distance. */
  marker: number;
}

/** A corner name entry from lovely-track-data. */
export interface TrackTurnMarker {
  name: string;
  /** Position as a fraction 0..1 of lap distance. */
  marker: number;
}

/** Supplementary track metadata from lovely-track-data. */
export interface TrackMetadata {
  country: string | null;
  /** Track length in meters. */
  length: number | null;
  /** Pit entry position as a fraction 0..1 of lap distance. */
  pitEntry: number | null;
  /** Pit exit position as a fraction 0..1 of lap distance. */
  pitExit: number | null;
  sectors: TrackSector[];
  /** Corner names from lovely-track-data, each with a marker (lap fraction). */
  lovelyTurns: TrackTurnMarker[];
}

export interface SlowSample {
  sim: string;
  trackName: string | null;
  sessionType: string | null;
  timeRemainingS: number | null;
  lapsRemaining: number | null;
  totalCars: number | null;
  lap: number | null;
  position: number | null;
  classPosition: number | null;
  lastLapS: number | null;
  bestLapS: number | null;
  currentLapS: number | null;
  deltaBestS: number | null;
  deltaSessionBestS: number | null;
  fuelL: number | null;
  /** Average fuel burned per lap (L), if the sim/source estimates it. */
  fuelPerLapL: number | null;

  /** The full field (may be empty if the sim/source doesn't provide it). */
  cars: CarEntry[];
  /** Which `carIdx` is the player. */
  playerCarIdx: number | null;
  /** Which `carIdx` is currently being spectated (camera target). */
  spectatedCarIdx: number | null;
  /** Player's car model name, for per-car profile auto-switching. */
  carName: string | null;
  /**
   * Whether the player is on track (driving) vs in the garage. `null` when the
   * sim doesn't distinguish — widgets gate on garage/track only when known.
   */
  onTrack: boolean | null;
  /** Whether the player is in the garage (vs out of car). `null` if unknown. */
  inGarage: boolean | null;
  /** Spotter: a car is alongside on the left / right (iRacing `CarLeftRight`). */
  carLeft: boolean | null;
  carRight: boolean | null;
  /**
   * Normalized track centerline for the Track Map widget: a closed loop of
   * `[x, y]` points in `0..1` (y down). `null` when the sim/source provides no
   * geometry (capability `trackMap`).
   */
  trackPath: [number, number][] | null;
  /**
   * Corner labels for the Track Map, in the same normalized `0..1` space as
   * `trackPath`. `null` when no turn data is available.
   */
  trackTurns: { label: string; x: number; y: number }[] | null;
  /**
   * Supplementary track metadata (corner names, sectors, pit markers) from
   * lovely-track-data. `null` when no metadata is bundled for this track.
   */
  trackMetadata: TrackMetadata | null;

  // Weather.
  /** Raw session flag bitfield (sim-specific bits). */
  flagsRaw: number | null;
  airTempC: number | null;
  trackTempC: number | null;
  /** Wind speed in m/s. */
  windSpeedMs: number | null;
  /** Wind direction in radians. */
  windDirRad: number | null;
  /** Track wetness fraction 0..1. */
  trackWetnessPct: number | null;
  /** Precipitation intensity 0..1. */
  precipitationPct: number | null;
  /** Relative humidity 0..1. */
  humidityPct: number | null;

  // Race control + chat feeds.
  messages: RaceControlMessage[];
  chatMessages: ChatMessage[];

  // Pit info.
  /** Pit-lane speed limit in m/s. */
  pitSpeedLimitMs: number | null;
  /** Distance to the player's pit box in meters. */
  pitBoxDistM: number | null;

  // Sector times.
  sectorTimesS: Sectors;
  sectorBestS: Sectors;

  // In-car setup / statuses.
  brakeBiasPct: number | null;
  absActive: boolean | null;
  tcActive: boolean | null;
  /** DRS state: 0=unavailable, 1=available, 2=armed, 3=active. */
  drsState: number | null;
  /** ERS deployment fraction 0..1. */
  ersPct: number | null;
  /** Fuel mix level (sim-specific integer). */
  fuelMix: number | null;
  /** Push-to-pass status. */
  p2pAvailable: number | null;
  tirePressures: TirePressures;
}

export interface Capabilities {
  clutch: boolean;
  steeringAngle: boolean;
  fuel: boolean;
  deltas: boolean;
  relativeGaps: boolean;
  irating: boolean;
  safetyRating: boolean;
  multiclass: boolean;
  /** Provides relative lateral/longitudinal car positions for the radar. */
  proximity: boolean;
  /** Provides track centerline geometry for the track map. */
  trackMap: boolean;
  /** Provides a race-control message feed (flags / penalties / info). */
  raceControl: boolean;
  /** A broadcast chat source is connected (e.g. stream chat). */
  chat: boolean;
  /** Provides weather data (wind, wetness, precipitation, humidity, temps). */
  weather: boolean;
  /** Provides per-sector split times. */
  sectors: boolean;
  /** Provides in-car setup states (brake bias, ABS, TC, DRS, tire pressures). */
  carSetup: boolean;
  /** Provides the currently spectated car index (camera target). */
  spectator: boolean;
  /** Provides pit-lane info (speed limit, pit-box distance, per-car pit status). */
  pitInfo: boolean;
}
