// Widget registry. Adding a widget = write a presentational component + its
// `WidgetDefinition`, then add it here. No core/layout changes needed (§10).

import type { WidgetDefinition } from "./contract";
import { inputGraphDef } from "./InputGraph";
import { deltaBarDef } from "./DeltaBar";
import { relativeDef } from "./Relative";
import { standingsDef } from "./Standings";
import { dashClusterDef } from "./DashCluster";
import { fuelSessionDef } from "./FuelSession";
import { radarDef } from "./Radar";
import { trackMapDef } from "./TrackMap";
import { flatmapDef } from "./Flatmap";
import { spotterDef } from "./Spotter";
import { trafficDef } from "./TrafficIndicator";
import { pitBoardDef } from "./PitBoard";
import { raceControlDef } from "./RaceControl";
import { chatDef } from "./Chat";
import { garageCoverDef } from "./GarageCover";
import { weatherDef } from "./Weather";
import { flagDef } from "./Flag";
import { lapTimerDef } from "./LapTimer";
import { sectorDeltaDef } from "./SectorDelta";
import { rejoinDef } from "./RejoinIndicator";
import { slowCarAheadDef } from "./SlowCarAhead";
import { cornerNameDef } from "./CornerName";
import { launchAssistDef } from "./LaunchAssist";
import { tachometerDef } from "./Tachometer";
import { heartRateDef } from "./HeartRate";
import { highlightedDriverDef } from "./HighlightedDriver";
import { pitlaneHelperDef } from "./PitlaneHelper";
import { telemetryInspectorDef } from "./TelemetryInspector";
import { setupComparisonDef } from "./SetupComparison";

const DEFS: WidgetDefinition<any>[] = [
  standingsDef,
  relativeDef,
  inputGraphDef,
  deltaBarDef,
  dashClusterDef,
  fuelSessionDef,
  radarDef,
  trackMapDef,
  flatmapDef,
  spotterDef,
  trafficDef,
  pitBoardDef,
  raceControlDef,
  chatDef,
  garageCoverDef,
  weatherDef,
  flagDef,
  lapTimerDef,
  sectorDeltaDef,
  rejoinDef,
  slowCarAheadDef,
  cornerNameDef,
  launchAssistDef,
  tachometerDef,
  heartRateDef,
  highlightedDriverDef,
  pitlaneHelperDef,
  telemetryInspectorDef,
  setupComparisonDef,
];

const BY_ID = new Map<string, WidgetDefinition<any>>(DEFS.map((d) => [d.id, d]));

export function allWidgetDefs(): WidgetDefinition<any>[] {
  return DEFS;
}

export function getWidgetDef(id: string): WidgetDefinition<any> | undefined {
  return BY_ID.get(id);
}
