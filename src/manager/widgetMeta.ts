// Presentation metadata for the widget catalog (monogram + blurb). Kept here so
// adding a widget doesn't require touching the widget files — unknown ids get a
// sensible fallback derived from the name.

export interface WidgetMeta {
  monogram: string;
  description: string;
}

const META: Record<string, WidgetMeta> = {
  "input-graph": {
    monogram: "IN",
    description: "Live throttle, brake, clutch & steering trace at full frame-rate.",
  },
  "dash-cluster": {
    monogram: "DSH",
    description: "At-a-glance dash: shift lights, gear, speed and a live steering wheel.",
  },
  tachometer: {
    monogram: "TAC",
    description: "Big analog rev counter with redline and shift-point markers.",
  },
  "delta-bar": {
    monogram: "Δ",
    description: "Gap to your best / session-best lap as a sliding bar.",
  },
  "lap-timer": {
    monogram: "LAP",
    description: "Current, last and best lap times with a live running clock.",
  },
  "sector-delta": {
    monogram: "SEC",
    description: "Per-sector time gains and losses versus your best lap.",
  },
  relative: {
    monogram: "REL",
    description: "Cars immediately around you on track, with time gaps.",
  },
  standings: {
    monogram: "POS",
    description: "Full field order with class, gaps and lap times.",
  },
  "highlighted-driver": {
    monogram: "DRV",
    description: "Spotlight one driver — their position, car, gap and pace.",
  },
  "fuel-session": {
    monogram: "FUEL",
    description: "Position, laps/time left and fuel strategy with margin to the finish.",
  },
  pit: {
    monogram: "PIT",
    description: "Stop plan: fuel to add, laps in the tank, tyre and limiter state.",
  },
  "pitlane-helper": {
    monogram: "PL",
    description: "Pit-lane speed limiter guidance and box-entry assist.",
  },
  radar: {
    monogram: "RAD",
    description: "Top-down proximity radar showing cars alongside you.",
  },
  spotter: {
    monogram: "SPT",
    description: "Edge bars that light when a car is beside you; warns when 3-wide.",
  },
  traffic: {
    monogram: "TRF",
    description: "Nearest faster/slower car, its class, gap and whether it's closing.",
  },
  "slow-car-ahead": {
    monogram: "SCA",
    description: "Warns when a much slower car is just ahead on track.",
  },
  "track-map": {
    monogram: "MAP",
    description: "Circuit map with live car positions.",
  },
  flatmap: {
    monogram: "FLT",
    description: "The field strung along a line by lap distance — a linear track order.",
  },
  "corner-name": {
    monogram: "COR",
    description: "Names the corner you're approaching as you lap the circuit.",
  },
  "launch-assist": {
    monogram: "LCH",
    description: "Standing-start helper: clutch bite, revs and bog/wheelspin cues.",
  },
  "rejoin-indicator": {
    monogram: "RJN",
    description: "Tells you when it's safe to rejoin after going off track.",
  },
  "setup-comparison": {
    monogram: "SET",
    description: "Compare two car setups side by side to spot what changed.",
  },
  "telemetry-inspector": {
    monogram: "TEL",
    description: "Raw live telemetry values — speed, temps, fuel and more.",
  },
  weather: {
    monogram: "WX",
    description: "Track and air temp, wind and conditions for the session.",
  },
  flag: {
    monogram: "FLG",
    description: "Full-screen flag state — green, yellow, blue, checkered and more.",
  },
  racecontrol: {
    monogram: "RC",
    description: "Feed of officials' messages: flags, penalties and info.",
  },
  chat: {
    monogram: "CHT",
    description: "Broadcast chat panel for streamers, from the live chat feed.",
  },
  garage: {
    monogram: "GAR",
    description: "\"Please stand by\" cover for streams with a session countdown.",
  },
  "heart-rate": {
    monogram: "HR",
    description: "Live heart-rate readout from a connected fitness sensor.",
  },
};

export function widgetMeta(id: string, name: string): WidgetMeta {
  return (
    META[id] ?? {
      monogram: name.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase() || "•",
      description: "Custom widget.",
    }
  );
}
