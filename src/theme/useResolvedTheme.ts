// Resolve the live Theme from app settings (pack + accent override).

import { useMemo } from "react";
import { useSettings } from "../store/appSettings";
import { resolveTheme, type Theme } from "./theme";

/** Overlay / gallery / previews — always the fully resolved pack. */
export function useResolvedTheme(): Theme {
  const { themeId, accentColor } = useSettings();
  return useMemo(() => resolveTheme(themeId, accentColor), [themeId, accentColor]);
}
