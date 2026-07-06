import { useSyncExternalStore } from "react";
import { useSlow } from "../store/hooks";
import { useScreenLayer } from "../components/screenLayer";
import { editModeStore } from "../store/editMode";
import type { FlagName } from "../store/types";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface FlagConfig {
  showLabel: boolean;
  glow: boolean;
}

const defaultConfig: FlagConfig = {
  showLabel: true,
  glow: true,
};

interface FlagInfo {
  flag: FlagName;
  name: string;
  color: string;
  checker?: boolean;
  border?: string;
  dim?: boolean;
}

// Sim-neutral flag state (`slow.flag`, backend `FlagState` enum). Priority
// order matches the backend's decode priority (highest first) and the old
// bit-priority table this replaced: red > checkered > black > yellow > debris
// > white > blue > green.
const PRIORITY: FlagInfo[] = [
  { flag: "red", name: "RED", color: "#ff495e" },
  { flag: "checkered", name: "CHECKERED", color: "#eef1f5", checker: true },
  { flag: "black", name: "BLACK", color: "#15151c", border: "#eef1f5" },
  { flag: "yellow", name: "YELLOW", color: "#ffb43d" },
  { flag: "debris", name: "DEBRIS", color: "#ff8a3d" },
  { flag: "white", name: "WHITE", color: "#eef1f5" },
  { flag: "blue", name: "BLUE", color: "#3d8bff" },
  { flag: "green", name: "GREEN", color: "#2fe08a" },
];

const NO_FLAG: FlagInfo = { flag: "none", name: "NO FLAG", color: "#2fe08a", dim: true };

const COLS = 9;
const ROWS = 6;

function Flag({ theme, config }: BaseWidgetProps<FlagConfig>) {
  const slow = useSlow();
  const editing = useSyncExternalStore(editModeStore.subscribe, editModeStore.get);
  const { preview } = useScreenLayer();
  const t = theme.colors;
  const flag = slow?.flag ?? "none";

  const active: FlagInfo = flag !== "none" ? PRIORITY.find((f) => f.flag === flag) ?? NO_FLAG : NO_FLAG;
  const glowColor = active.border ?? active.color;
  const litColor = active.color;
  const noFlag = active === NO_FLAG;

  // Hide the widget entirely when no flag is flying — a flag display is only
  // meaningful when there's a flag. Stay visible while editing the layout (so it
  // can be placed/moved) and in the manager preview (so the gallery shows it).
  if (noFlag && !editing && !preview) return null;

  // In the live overlay the host now paints no panel chrome for this widget (so
  // the no-flag case leaves nothing behind), so when a flag IS up we paint our
  // own panel here. While editing / in preview the host (or preview card) still
  // supplies the panel, so we stay transparent to avoid doubling it up.
  const selfPanel = !editing && !preview;

  const cells: React.ReactNode[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const checkerLit = active.checker ? (r + c) % 2 === 0 : true;
      const lit = checkerLit && !noFlag;
      // Unlit checker squares need to actually read as "dark checker square", not
      // a translucent chip — at low panel opacity/light backdrops the old
      // rgba(255,255,255,0.05)@0.4 unlit cell washed out to nearly the same tone
      // as the lit white cell, making CHECKERED indistinguishable from WHITE
      // (audit 7). An opaque dark fill fixes that on any backdrop.
      const isUnlitChecker = active.checker && !lit && !noFlag;
      // Glow scales with the widget's font size so the LED bloom stays
      // proportional to the cell size — a fixed-px glow bled small cells into
      // each other at min size and looked sparse at large sizes.
      const boxShadow = config.glow && lit ? `0 0 0.42em ${glowColor}, 0 0 0.12em ${glowColor}` : lit ? `0 0 0.12em ${glowColor}` : "none";
      cells.push(
        <div
          key={`${r}-${c}`}
          style={{
            borderRadius: "0.16em",
            background: lit ? litColor : noFlag ? `${active.color}33` : isUnlitChecker ? "#0a0b0e" : "rgba(255,255,255,0.05)",
            boxShadow,
            border: lit && active.border ? `1px solid ${active.border}` : "none",
            opacity: lit ? 1 : noFlag ? 0.6 : isUnlitChecker ? 1 : 0.4,
          }}
        />
      );
    }
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        color: t.text,
        padding: theme.widgetPad,
        boxSizing: "border-box",
        overflow: "hidden",
        ...(selfPanel
          ? {
              background: t.surface,
              border: `1px solid ${t.surfaceBorder}`,
              borderRadius: theme.radius,
              backdropFilter: theme.panelBlur,
              WebkitBackdropFilter: theme.panelBlur,
              boxShadow: theme.panelShadow,
            }
          : null),
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: `repeat(${COLS}, 1fr)`, gridTemplateRows: `repeat(${ROWS}, 1fr)`, gap: "0.22em" }}>
        {cells}
      </div>
      {config.showLabel && (
        <div
          style={{
            fontFamily: theme.font.label,
            marginTop: theme.space.md,
            textAlign: "center",
            fontWeight: 700,
            fontSize: "0.78em",
            letterSpacing: "0.16em",
            // Compensate for trailing letter-spacing so the tracked-out caps sit
            // optically centred instead of nudged left by the final gap.
            paddingLeft: "0.16em",
            color: noFlag ? t.textDim : active.color,
            textShadow: config.glow && !noFlag ? `0 0 0.5em ${glowColor}` : "none",
          }}
        >
          {active.name}
        </div>
      )}
    </div>
  );
}

export const flagDef: WidgetDefinition<FlagConfig> = {
  id: "flag",
  name: "Flag",
  defaultSize: { w: 180, h: 140 },
  minSize: { w: 120, h: 100 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["raceControl"],
  configSchema: [
    { key: "showLabel", label: "Show label", type: "boolean" },
    { key: "glow", label: "LED glow", type: "boolean" },
  ],
  // The widget hides itself when no flag is flying (renders nothing), so the host
  // must paint no panel chrome around it outside edit mode — otherwise an empty
  // panel would linger. When a flag is up the component paints its own panel.
  transparentPanel: () => true,
  Component: Flag,
};
