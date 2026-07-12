/** Design-system public surface — theme packs + live resolve helpers. */

export {
  apexTheme,
  graphiteTheme,
  THEME_PACKS,
  THEME_OPTIONS,
  DEFAULT_THEME_ID,
  defaultTheme,
  resolveTheme,
  isThemeId,
  type Theme,
  type ThemeId,
  type ThemeColors,
  type ThemeFont,
  type ThemeGlass,
  type ThemeList,
} from "./theme";

export { useResolvedTheme } from "./useResolvedTheme";
