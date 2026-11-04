"use strict";
/* Display: light / dark / system mode, a theme and an accent color.

   Loaded in <head>, right after style.css (the browser runs it once the
   stylesheet is in), so the first paint already has the right colors.
   style.css holds Snap Studio's own tokens, light and dark, selected by
   data-scheme on <html>; another theme only writes the tokens it changes,
   inline on <html>. Surfaces drawn outside CSS (WebGL, terminals) read
   the resolved tokens and listen to the "themechange" event.

   The top half is pure (no DOM) and tested by scripts/test-themes.js. */

const DISPLAY_KEY = "snapstudio.display";
const DISPLAY_MODES = ["system", "light", "dark"];
const DISPLAY_DEFAULT = { mode: "system", theme: "studio", accent: "theme", cvd: false };

/* Accent presets (macOS colors). "theme" takes the theme's own accent,
   "system" the OS accent (AccentColor), a #rrggbb value is custom. */
const ACCENTS = [
  { id: "blue", hex: "#007aff", name: "display.accent.blue" },
  { id: "purple", hex: "#af52de", name: "display.accent.purple" },
  { id: "pink", hex: "#ff2d55", name: "display.accent.pink" },
  { id: "red", hex: "#ff3b30", name: "display.accent.red" },
  { id: "orange", hex: "#ff9500", name: "display.accent.orange" },
  { id: "yellow", hex: "#ffcc00", name: "display.accent.yellow" },
  { id: "green", hex: "#28cd41", name: "display.accent.green" },
  { id: "graphite", hex: "#8e8e93", name: "display.accent.graphite" },
];

/* Colour-blind safe colors, over any theme: the states in Okabe-Ito
   colors told apart without red / green: blue (fine), orange (caution),
   reddish purple (error). */
const CVD_TOKENS = {
  light: {
    "--danger": "#a3307e",
    "--warning": "#e69f00",
    "--success": "#0072b2",
    "--success-text": "#005b8f",
    "--warning-text": "#8a5800",
    // Bed mesh scale: blue → yellow → vermilion, told apart without red / green.
    "--mesh-low": "#0072b2",
    "--mesh-mid": "#f0e442",
    "--mesh-high": "#d55e00",
  },
  dark: {
    "--danger": "#e08fc6",
    "--warning": "#e69f00",
    "--success": "#56b4e9",
    "--success-text": "#56b4e9",
    "--warning-text": "#f0b429",
    "--mesh-low": "#56b4e9",
    "--mesh-mid": "#f0e442",
    "--mesh-high": "#d55e00",
  },
};

/* Themes: each one gives its light and dark values, only for the tokens
   it changes (Snap Studio's are in style.css). `accent` is the theme's
   own accent per mode; none means the system accent. */
const THEMES = [
  { id: "studio", name: "display.theme.studio", sub: "display.theme.studio.sub", accent: null, tokens: { light: {}, dark: {} } },
  {
    id: "space",
    name: "display.theme.space",
    sub: "display.theme.space.sub",
    accent: { light: "#0c63e2", dark: "#3d8bff" },
    // The Snapmaker console: a navy sidebar in both modes, surfaces with a
    // touch of blue.
    tokens: {
      light: {
        "--content-bg": "#eef3fa",
        "--card-bg": "#ffffff",
        "--card-border": "#dfe6f1",
        "--sidebar-bg": "rgba(11, 26, 51, 0.94)",
        "--sidebar-opaque": "#0b1a33",
        "--sidebar-item-hover": "rgba(255, 255, 255, 0.08)",
        "--sidebar-item-selected-inactive": "rgba(255, 255, 255, 0.16)",
        "--sidebar-text": "#f1f5fb",
        "--sidebar-text-secondary": "#aebcd2",
        "--sidebar-text-tertiary": "#7487a6",
        "--text": "#16202e",
        "--text-secondary": "#5a6577",
        "--text-tertiary": "#97a1b0",
        "--separator": "#dbe3ee",
        "--control-bg": "#ffffff",
        "--control-border": "#d3dce8",
        "--field-bg": "#ffffff",
        "--field-border": "#cfd8e5",
        "--sheet-bg": "#f6f9fd",
        "--seg-on": "#ffffff",
        "--thumb-bg": "linear-gradient(160deg, #f6f9fd 0%, #e6ecf5 100%)",
        "--term-selection": "#c9dcfb",
      },
      dark: {
        "--content-bg": "#101828",
        "--card-bg": "#172235",
        "--card-border": "rgba(150, 180, 230, 0.1)",
        "--sidebar-bg": "rgba(8, 17, 33, 0.9)",
        "--sidebar-opaque": "#081121",
        "--sidebar-item-hover": "rgba(255, 255, 255, 0.07)",
        "--sidebar-item-selected-inactive": "rgba(255, 255, 255, 0.14)",
        "--text": "#eef2f8",
        "--text-secondary": "#a3b0c4",
        "--text-tertiary": "#66748b",
        "--separator": "#26334a",
        "--control-bg": "rgba(160, 190, 240, 0.08)",
        "--control-border": "#2c3a53",
        "--field-bg": "#0c1424",
        "--field-border": "#34445f",
        "--sheet-bg": "#141f32",
        "--seg-on": "#2c3b57",
        "--toast-bg": "rgba(23, 34, 53, 0.96)",
        "--thumb-bg": "linear-gradient(160deg, #1b2840 0%, #121c2e 100%)",
        "--term-selection": "#26406a",
      },
    },
  },
  {
    id: "contrast",
    name: "display.theme.contrast",
    sub: "display.theme.contrast.sub",
    accent: { light: "#0040dd", dark: "#409cff" },
    tokens: {
      light: {
        "--content-bg": "#ffffff",
        "--card-bg": "#ffffff",
        "--card-border": "rgba(0, 0, 0, 0.55)",
        "--sidebar-bg": "rgba(242, 242, 242, 0.94)",
        "--sidebar-opaque": "#f2f2f2",
        "--sidebar-item-hover": "rgba(0, 0, 0, 0.1)",
        "--sidebar-item-selected-inactive": "rgba(0, 0, 0, 0.2)",
        "--text": "#000000",
        "--text-secondary": "#3a3a3c",
        "--text-tertiary": "#6c6c70",
        "--separator": "rgba(0, 0, 0, 0.5)",
        "--control-bg": "#ffffff",
        "--control-border": "rgba(0, 0, 0, 0.6)",
        "--control-bg-hover": "rgba(0, 0, 0, 0.08)",
        "--field-bg": "#ffffff",
        "--field-border": "rgba(0, 0, 0, 0.65)",
        "--focus-ring": "0 0 0 3px var(--accent)",
        "--sheet-bg": "#ffffff",
        "--sheet-shadow": "0 20px 60px rgba(0, 0, 0, 0.35), 0 0 0 2px #000000",
        "--toast-bg": "#000000",
        "--toast-text": "#ffffff",
        "--danger": "#d70015",
        "--warning": "#b25000",
        "--success": "#248a3d",
        "--success-text": "#1b6e2f",
        "--warning-text": "#8a3d00",
        "--ring-track": "rgba(0, 0, 0, 0.2)",
        "--seg-on": "#ffffff",
        "--thumb-bg": "#f2f2f2",
        "--term-selection": "#9cc6ff",
      },
      dark: {
        "--content-bg": "#000000",
        "--card-bg": "#121212",
        "--card-border": "rgba(255, 255, 255, 0.55)",
        "--sidebar-bg": "rgba(10, 10, 10, 0.94)",
        "--sidebar-opaque": "#0a0a0a",
        "--sidebar-item-hover": "rgba(255, 255, 255, 0.14)",
        "--sidebar-item-selected-inactive": "rgba(255, 255, 255, 0.24)",
        "--text": "#ffffff",
        "--text-secondary": "#d1d1d6",
        "--text-tertiary": "#aeaeb2",
        "--separator": "rgba(255, 255, 255, 0.5)",
        "--control-bg": "#1c1c1e",
        "--control-border": "rgba(255, 255, 255, 0.6)",
        "--control-bg-hover": "rgba(255, 255, 255, 0.14)",
        "--field-bg": "#000000",
        "--field-border": "rgba(255, 255, 255, 0.65)",
        "--focus-ring": "0 0 0 3px var(--accent)",
        "--sheet-bg": "#121212",
        "--sheet-shadow": "0 20px 60px rgba(0, 0, 0, 0.7), 0 0 0 2px #ffffff",
        "--toast-bg": "#ffffff",
        "--toast-text": "#000000",
        "--danger": "#ff6961",
        "--warning": "#ffb340",
        "--success": "#30db5b",
        "--success-text": "#30db5b",
        "--warning-text": "#ffb340",
        "--ring-track": "rgba(255, 255, 255, 0.3)",
        "--seg-on": "#3a3a3c",
        "--thumb-bg": "#1c1c1e",
        "--term-selection": "#1f4a8a",
      },
    },
  },  {
    // Workshop: neutral anthracite (no blue), a very dark sidebar, cards a
    // step lighter, a discreet Snapmaker orange. Light: concrete grey under
    // the same anthracite sidebar.
    id: "graphite",
    name: "display.theme.graphite",
    sub: "display.theme.graphite.sub",
    accent: { light: "#b4500f", dark: "#e8803a" },
    tokens: {
      light: {
        "--content-bg": "#e7e8e9",
        "--card-bg": "#f6f6f7",
        "--card-border": "rgba(40, 42, 46, 0.1)",
        "--sidebar-bg": "rgba(36, 37, 39, 0.94)",
        "--sidebar-opaque": "#242527",
        "--sidebar-item-hover": "rgba(255, 255, 255, 0.07)",
        "--sidebar-item-selected-inactive": "rgba(255, 255, 255, 0.15)",
        "--sidebar-text": "#ededed",
        "--sidebar-text-secondary": "#a8a8a8",
        "--sidebar-text-tertiary": "#707070",
        "--text": "#1c1b1a",
        "--text-secondary": "#5b5853",
        "--text-tertiary": "#9a958f",
        "--separator": "#d5d1cb",
        "--control-bg": "#f7f6f4",
        "--control-border": "#cdc9c2",
        "--field-bg": "#fbfaf8",
        "--field-border": "#cac5be",
        "--sheet-bg": "#f2f0ed",
        "--seg-on": "#fbfaf8",
        "--danger": "#d8301f",
        "--thumb-bg": "linear-gradient(160deg, #f4f2ef 0%, #e4e1dc 100%)",
        "--term-selection": "#f1d0b5",
      },
      dark: {
        "--content-bg": "#1f1f1f",
        "--card-bg": "#2a2a2a",
        "--card-border": "rgba(255, 255, 255, 0.05)",
        "--sidebar-bg": "rgba(18, 18, 18, 0.82)",
        "--sidebar-opaque": "#131313",
        "--sidebar-item-hover": "rgba(255, 255, 255, 0.06)",
        "--text": "#ececec",
        "--text-secondary": "#a6a6a6",
        "--text-tertiary": "#6e6e6e",
        "--separator": "#383838",
        "--control-bg": "rgba(255, 255, 255, 0.06)",
        "--control-border": "#3d3d3d",
        "--field-bg": "#181818",
        "--field-border": "#474747",
        "--sheet-bg": "#262626",
        "--seg-on": "#3a3a3a",
        "--toast-bg": "rgba(42, 42, 42, 0.96)",
        "--thumb-bg": "linear-gradient(160deg, #2f2f2f 0%, #232323 100%)",
        "--term-selection": "#4d3523",
      },
    },
  },
  {
    // OLED: near-black, cards barely lighter, no borders, cyan. Light: cool
    // blue-grey surfaces under an anthracite sidebar, a deep cyan (the
    // bright one would not read).
    id: "night",
    name: "display.theme.night",
    sub: "display.theme.night.sub",
    accent: { light: "#0e7490", dark: "#22d3ee" },
    tokens: {
      light: {
        "--content-bg": "#edf2f5",
        "--card-bg": "#ffffff",
        "--card-border": "rgba(0, 0, 0, 0)",
        "--card-shadow": "0 1px 2px rgba(10, 40, 60, 0.06), 0 3px 12px rgba(10, 40, 60, 0.06)",
        "--sidebar-bg": "rgba(24, 29, 35, 0.94)",
        "--sidebar-opaque": "#181d23",
        "--sidebar-item-hover": "rgba(255, 255, 255, 0.07)",
        "--sidebar-item-selected-inactive": "rgba(255, 255, 255, 0.15)",
        "--sidebar-text": "#e9eef2",
        "--sidebar-text-secondary": "#a1abb5",
        "--sidebar-text-tertiary": "#6b7682",
        "--text": "#0d1418",
        "--text-secondary": "#4f5b63",
        "--text-tertiary": "#93a0a8",
        "--separator": "#d8e1e7",
        "--control-bg": "#ffffff",
        "--control-border": "#d2dce3",
        "--field-bg": "#ffffff",
        "--field-border": "#cdd8df",
        "--sheet-bg": "#f4f8fa",
        "--seg-on": "#ffffff",
        "--thumb-bg": "linear-gradient(160deg, #f6f9fb 0%, #e3eaef 100%)",
        "--term-selection": "#bfeaf3",
      },
      dark: {
        "--content-bg": "#000000",
        "--card-bg": "#0b0b0c",
        "--card-border": "rgba(0, 0, 0, 0)",
        "--card-shadow": "0 0 0 0 transparent",
        "--card-shadow-hover": "0 0 0 1px rgba(255, 255, 255, 0.08)",
        "--sidebar-bg": "rgba(0, 0, 0, 0.82)",
        "--sidebar-opaque": "#050505",
        "--sidebar-item-hover": "rgba(255, 255, 255, 0.06)",
        "--text": "#e8e8ea",
        "--text-secondary": "#9c9ca3",
        "--text-tertiary": "#5c5c62",
        "--separator": "#1c1c1f",
        "--control-bg": "#111113",
        "--control-border": "#26262a",
        "--field-bg": "#0b0b0c",
        "--field-border": "#2c2c31",
        "--sheet-bg": "#0e0e10",
        "--sheet-shadow": "0 20px 60px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.07)",
        "--seg-on": "#222226",
        "--toast-bg": "rgba(28, 28, 30, 0.96)",
        "--thumb-bg": "linear-gradient(160deg, #0f0f11 0%, #060607 100%)",
        "--term-selection": "#0f3a44",
        "--modal-dim": "rgba(0, 0, 0, 0.6)",
      },
    },
  },
  {
    // Paper: a warm off-white, soft shadows rather than borders, a sage
    // green. Dark: warm brown.
    id: "studiolight",
    name: "display.theme.studiolight",
    sub: "display.theme.studiolight.sub",
    accent: { light: "#3d7352", dark: "#8cc4a0" },
    tokens: {
      light: {
        "--content-bg": "#f2ebdf",
        "--card-bg": "#fffcf6",
        "--card-border": "rgba(0, 0, 0, 0)",
        "--card-shadow": "0 1px 2px rgba(70, 45, 15, 0.08), 0 4px 16px rgba(70, 45, 15, 0.1)",
        "--card-shadow-hover": "0 3px 8px rgba(70, 45, 15, 0.12), 0 12px 30px rgba(70, 45, 15, 0.14)",
        "--sidebar-bg": "rgba(232, 222, 205, 0.8)",
        "--sidebar-opaque": "#e8decd",
        "--sidebar-item-hover": "rgba(70, 45, 15, 0.07)",
        "--text": "#231d15",
        "--text-secondary": "#5f5547",
        "--text-tertiary": "#a29684",
        "--separator": "#e2d7c5",
        "--control-bg": "#fffcf6",
        "--control-border": "#d9ccb7",
        "--field-bg": "#fffcf6",
        "--field-border": "#d4c6af",
        "--sheet-bg": "#f9f4eb",
        "--sheet-shadow": "0 20px 60px rgba(70, 45, 15, 0.24), 0 2px 8px rgba(70, 45, 15, 0.1)",
        "--seg-on": "#fffcf6",
        "--thumb-bg": "linear-gradient(160deg, #faf5ec 0%, #ebe1d0 100%)",
        "--term-selection": "#cfe3d5",
        "--danger": "#d92d20",
      },
      dark: {
        "--content-bg": "#272019",
        "--card-bg": "#322920",
        "--card-border": "rgba(0, 0, 0, 0)",
        "--card-shadow": "0 1px 2px rgba(0, 0, 0, 0.35), 0 4px 14px rgba(0, 0, 0, 0.3)",
        "--card-shadow-hover": "0 3px 8px rgba(0, 0, 0, 0.4), 0 12px 28px rgba(0, 0, 0, 0.4)",
        "--sidebar-bg": "rgba(31, 25, 19, 0.8)",
        "--sidebar-opaque": "#1f1913",
        "--sidebar-item-hover": "rgba(255, 240, 220, 0.06)",
        "--text": "#f3ece1",
        "--text-secondary": "#b2a693",
        "--text-tertiary": "#76695a",
        "--separator": "#3e342a",
        "--control-bg": "rgba(255, 240, 220, 0.06)",
        "--control-border": "#433829",
        "--field-bg": "#221c16",
        "--field-border": "#4d4132",
        "--sheet-bg": "#2e261e",
        "--sheet-shadow": "0 20px 60px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.3)",
        "--seg-on": "#463a2d",
        "--toast-bg": "rgba(52, 43, 34, 0.96)",
        "--thumb-bg": "linear-gradient(160deg, #372d23 0%, #29221b 100%)",
        "--term-selection": "#2f4a3a",
      },
    },
  },
  {
    // Nord: polar night, snow storm, frost; the glacier blue as accent,
    // aurora colors for the states.
    id: "nord",
    name: "display.theme.nord",
    sub: "display.theme.nord.sub",
    accent: { light: "#4c6f99", dark: "#88c0d0" },
    tokens: {
      light: {
        "--content-bg": "#e5e9f0",
        "--card-bg": "#eceff4",
        "--card-border": "rgba(46, 52, 64, 0.1)",
        "--sidebar-bg": "rgba(216, 222, 233, 0.72)",
        "--sidebar-opaque": "#d8dee9",
        "--text": "#2e3440",
        "--text-secondary": "#4c566a",
        "--text-tertiary": "#7b88a1",
        "--separator": "#cdd4df",
        "--control-bg": "#eceff4",
        "--control-border": "#c3cbd8",
        "--field-bg": "#f4f6f9",
        "--field-border": "#c3cbd8",
        "--sheet-bg": "#eceff4",
        "--seg-on": "#f4f6f9",
        "--toast-bg": "rgba(46, 52, 64, 0.94)",
        "--danger": "#bf616a",
        "--warning": "#d08770",
        "--success": "#a3be8c",
        "--success-text": "#4f6b3c",
        "--warning-text": "#8c5a12",
        "--thumb-bg": "linear-gradient(160deg, #eceff4 0%, #dde2ea 100%)",
        "--term-selection": "#c6d6e8",
      },
      dark: {
        "--content-bg": "#2e3440",
        "--card-bg": "#3b4252",
        "--card-border": "rgba(236, 239, 244, 0.06)",
        "--sidebar-bg": "rgba(39, 44, 54, 0.78)",
        "--sidebar-opaque": "#272c36",
        "--sidebar-item-hover": "rgba(236, 239, 244, 0.07)",
        "--text": "#eceff4",
        "--text-secondary": "#c0c8d6",
        "--text-tertiary": "#7b88a1",
        "--separator": "#434c5e",
        "--control-bg": "#3b4252",
        "--control-border": "#4c566a",
        "--field-bg": "#2e3440",
        "--field-border": "#4c566a",
        "--sheet-bg": "#353c4a",
        "--seg-on": "#4c566a",
        "--toast-bg": "rgba(59, 66, 82, 0.96)",
        "--danger": "#d9808a",
        "--warning": "#ebcb8b",
        "--success": "#a3be8c",
        "--success-text": "#a3be8c",
        "--warning-text": "#ebcb8b",
        "--thumb-bg": "linear-gradient(160deg, #3b4252 0%, #323845 100%)",
        "--term-selection": "#434c5e",
      },
    },
  },
  {
    // Solarized (Ethan Schoonover). The body text is one step more
    // emphasized than the original's (base02 / base2 rather than base00 /
    // base0, which stay under 7:1) and the light secondary text a shade
    // darker than base01.
    id: "solarized",
    name: "display.theme.solarized",
    sub: "display.theme.solarized.sub",
    accent: { light: "#cb4b16", dark: "#b58900" },
    tokens: {
      light: {
        "--content-bg": "#eee8d5",
        "--card-bg": "#fdf6e3",
        "--card-border": "rgba(88, 110, 117, 0.16)",
        "--sidebar-bg": "rgba(238, 232, 213, 0.75)",
        "--sidebar-opaque": "#e6dfca",
        "--text": "#073642",
        "--text-secondary": "#4a5f66",
        "--text-tertiary": "#93a1a1",
        "--separator": "#ddd6c1",
        "--control-bg": "#fdf6e3",
        "--control-border": "#d3cbb4",
        "--field-bg": "#fdf6e3",
        "--field-border": "#cfc7af",
        "--sheet-bg": "#f6efdc",
        "--seg-on": "#fdf6e3",
        "--toast-bg": "rgba(7, 54, 66, 0.95)",
        "--toast-text": "#eee8d5",
        "--danger": "#dc322f",
        "--warning": "#b58900",
        "--success": "#859900",
        "--success-text": "#5c6a00",
        "--warning-text": "#7f6000",
        "--thumb-bg": "linear-gradient(160deg, #fdf6e3 0%, #ebe4cf 100%)",
        "--term-selection": "#e3d9b9",
      },
      dark: {
        "--content-bg": "#002b36",
        "--card-bg": "#073642",
        "--card-border": "rgba(147, 161, 161, 0.1)",
        "--sidebar-bg": "rgba(0, 33, 42, 0.8)",
        "--sidebar-opaque": "#00212a",
        "--sidebar-item-hover": "rgba(147, 161, 161, 0.1)",
        "--text": "#eee8d5",
        "--text-secondary": "#93a1a1",
        "--text-tertiary": "#657b83",
        "--separator": "#0e4553",
        "--control-bg": "#073642",
        "--control-border": "#174f5c",
        "--field-bg": "#002b36",
        "--field-border": "#1b5664",
        "--sheet-bg": "#04313c",
        "--seg-on": "#174f5c",
        "--toast-bg": "rgba(7, 54, 66, 0.96)",
        "--danger": "#f0605c",
        "--warning": "#b58900",
        "--success": "#859900",
        "--success-text": "#a7bd00",
        "--warning-text": "#d4a400",
        "--thumb-bg": "linear-gradient(160deg, #073642 0%, #002f3b 100%)",
        "--term-selection": "#0e4553",
        "--term-fg": "#93a1a1",
      },
    },
  },
  {
    // Neutral surfaces tinted with the color of the spool on head T0 of
    // the active printer (`accentFrom`), which is the accent too; a
    // neutral slate without one.
    id: "filament",
    name: "display.theme.filament",
    sub: "display.theme.filament.sub",
    accentFrom: "spool",
    accent: { light: "#56606e", dark: "#9aa4b3" },
    tokens: {
      light: {
        "--content-bg": "#f2f2f2",
        "--card-bg": "#ffffff",
        "--card-border": "rgba(0, 0, 0, 0.08)",
        "--sidebar-bg": "rgba(233, 233, 233, 0.7)",
        "--sidebar-opaque": "#e9e9e9",
        "--text": "#1a1a1a",
        "--text-secondary": "#5c5c5c",
        "--text-tertiary": "#9e9e9e",
        "--separator": "#dedede",
        "--control-bg": "#ffffff",
        "--control-border": "#d4d4d4",
        "--field-bg": "#ffffff",
        "--field-border": "#d0d0d0",
        "--sheet-bg": "#f7f7f7",
        "--seg-on": "#ffffff",
        "--thumb-bg": "linear-gradient(160deg, #f7f7f7 0%, #e8e8e8 100%)",
        "--term-selection": "#d6d6d6",
      },
      dark: {
        "--content-bg": "#1b1b1b",
        "--card-bg": "#262626",
        "--card-border": "rgba(255, 255, 255, 0.06)",
        "--sidebar-bg": "rgba(20, 20, 20, 0.78)",
        "--sidebar-opaque": "#141414",
        "--sidebar-item-hover": "rgba(255, 255, 255, 0.06)",
        "--text": "#f0f0f0",
        "--text-secondary": "#a8a8a8",
        "--text-tertiary": "#6a6a6a",
        "--separator": "#363636",
        "--control-bg": "rgba(255, 255, 255, 0.06)",
        "--control-border": "#3a3a3a",
        "--field-bg": "#161616",
        "--field-border": "#444444",
        "--sheet-bg": "#222222",
        "--seg-on": "#3a3a3a",
        "--toast-bg": "rgba(38, 38, 38, 0.96)",
        "--thumb-bg": "linear-gradient(160deg, #2b2b2b 0%, #202020 100%)",
        "--term-selection": "#3d3d3d",
      },
    },
  },
  {
    // macOS 26 Tahoe (Liquid Glass). The colors are here; the structure
    // (wallpaper, floating glass sidebar, toolbar capsules, capsule
    // controls, glass sheets) is in style.css under [data-theme="macos"].
    // The surfaces are see-through over that wallpaper; --content-bg stays
    // a solid color for what needs one (3D views, terminals).
    id: "macos",
    name: "display.theme.macos",
    sub: "display.theme.macos.sub",
    accent: null,
    tokens: {
      light: {
        "--content-bg": "#eef0f6",
        "--card-bg": "rgba(255, 255, 255, 0.7)",
        "--card-border": "rgba(255, 255, 255, 0)",
        "--card-shadow": "0 1px 3px rgba(30, 40, 80, 0.06), 0 8px 24px rgba(30, 40, 80, 0.07)",
        "--card-shadow-hover": "0 3px 8px rgba(30, 40, 80, 0.08), 0 14px 32px rgba(30, 40, 80, 0.12)",
        "--sidebar-bg": "rgba(255, 255, 255, 0.52)",
        "--sidebar-opaque": "#f0f1f6",
        "--sidebar-item-hover": "rgba(0, 0, 0, 0.05)",
        "--text": "#1d1d1f",
        "--text-secondary": "#56565c",
        "--text-tertiary": "#9a9aa0",
        "--separator": "rgba(60, 60, 67, 0.12)",
        "--control-bg": "rgba(255, 255, 255, 0.66)",
        "--control-border": "rgba(0, 0, 0, 0.08)",
        "--field-bg": "rgba(255, 255, 255, 0.78)",
        "--field-border": "rgba(0, 0, 0, 0.08)",
        "--sheet-bg": "#f5f6fa",
        "--sheet-shadow": "0 30px 80px rgba(30, 40, 80, 0.25), 0 2px 8px rgba(30, 40, 80, 0.1)",
        "--seg-on": "#ffffff",
        "--radius-card": "24px",
        "--radius-control": "12px",
        "--glass-mix": "72%",
        "--glass-blur": "blur(28px) saturate(190%)",
        "--glass-edge": "inset 0 0 0 1px rgba(255, 255, 255, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.95)",
        "--thumb-bg": "linear-gradient(160deg, rgba(255, 255, 255, 0.8) 0%, rgba(236, 238, 245, 0.8) 100%)",
      },
      dark: {
        "--content-bg": "#1a1b22",
        "--card-bg": "rgba(52, 52, 58, 0.62)",
        "--card-border": "rgba(255, 255, 255, 0)",
        "--card-shadow": "0 1px 3px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.3)",
        "--card-shadow-hover": "0 3px 8px rgba(0, 0, 0, 0.35), 0 14px 32px rgba(0, 0, 0, 0.45)",
        "--sidebar-bg": "rgba(46, 46, 52, 0.5)",
        "--sidebar-opaque": "#24242a",
        "--sidebar-item-hover": "rgba(255, 255, 255, 0.07)",
        "--text": "#f5f5f7",
        "--text-secondary": "#a8a8ae",
        "--text-tertiary": "#6e6e74",
        "--separator": "rgba(255, 255, 255, 0.1)",
        "--control-bg": "rgba(255, 255, 255, 0.1)",
        "--control-border": "rgba(255, 255, 255, 0.1)",
        "--field-bg": "rgba(255, 255, 255, 0.08)",
        "--field-border": "rgba(255, 255, 255, 0.1)",
        "--sheet-bg": "#2a2a30",
        "--sheet-shadow": "0 30px 80px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.35)",
        "--seg-on": "rgba(255, 255, 255, 0.2)",
        "--radius-card": "24px",
        "--radius-control": "12px",
        "--glass-mix": "64%",
        "--glass-blur": "blur(28px) saturate(190%)",
        "--glass-edge": "inset 0 0 0 1px rgba(255, 255, 255, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.16)",
        "--thumb-bg": "linear-gradient(160deg, rgba(70, 70, 78, 0.6) 0%, rgba(44, 44, 50, 0.6) 100%)",
      },
    },
  },
];

const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
const DISPLAY_HEX = /^#[0-9a-f]{6}$/;

/* Stored settings, made safe: unknown values fall back to the defaults. */
function displayNormalize(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const accent = String(s.accent || "").toLowerCase();
  return {
    mode: DISPLAY_MODES.includes(s.mode) ? s.mode : DISPLAY_DEFAULT.mode,
    theme: THEMES.some((t) => t.id === s.theme) ? s.theme : DISPLAY_DEFAULT.theme,
    accent: accent === "theme" || accent === "system" || ACCENTS.some((a) => a.id === accent) || DISPLAY_HEX.test(accent) ? accent : DISPLAY_DEFAULT.accent,
    // Colour-blind safe was a theme before it became an option.
    cvd: s.cvd === true || s.theme === "cvd",
  };
}

const displayResolveMode = (mode, systemDark) => (mode === "light" || mode === "dark" ? mode : systemDark ? "dark" : "light");

/* The accent to write (#rrggbb), or null for the system accent. `spool`
   is the color of the spool on T0 (#rrggbb or null), for a theme taking
   its accent from it (Filament). */
function displayAccent(s, mode, spool = null) {
  if (s.accent === "system") return null;
  const t = themeById(s.theme);
  if (s.accent === "theme" && t.accentFrom === "spool") {
    return filamentAccent(spool, mode, t.tokens[mode]["--content-bg"], t.accent[mode]);
  }
  if (s.accent === "theme") return t.accent?.[mode] || null;
  const preset = ACCENTS.find((a) => a.id === s.accent);
  return preset ? preset.hex : s.accent;
}

/* Tokens written inline for these settings in this mode: the theme's
   overrides and the accent. --accent-text is added by the caller once the
   accent's color is known (AccentColor is only known to the browser). */
function displayTokens(s, mode, spool = null) {
  const t = themeById(s.theme);
  const out = { ...t.tokens[mode], ...(t.accentFrom === "spool" ? filamentTint(t.tokens[mode], spool) : {}), ...(s.cvd ? CVD_TOKENS[mode] : {}) };
  const accent = displayAccent(s, mode, spool);
  if (accent) out["--accent"] = accent;
  return out;
}

/* Colors: "#rgb", "#rrggbb", "rgb(…)" or "rgba(…)" → [r, g, b, a]. */
function parseColor(c) {
  c = String(c).trim().toLowerCase();
  let m = c.match(/^#([0-9a-f]{3})$/);
  if (m) return [...m[1]].map((x) => parseInt(x + x, 16)).concat(1);
  m = c.match(/^#([0-9a-f]{6})$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.slice(0, 3).every(isFinite)) return [p[0], p[1], p[2], p.length > 3 && isFinite(p[3]) ? p[3] : 1];
  }
  return null;
}

/* A translucent color seen over an opaque background. */
const blendOver = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);

function luminance([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/* WCAG contrast ratio between two opaque colors. */
function contrastRatio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const toHex = (rgb) => "#" + rgb.slice(0, 3).map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

/* Color of the spool on head T0 among a printer's slots ({ index,
   present, color }), as #rrggbb; null when there is none or it is empty. */
function spoolT0(slots) {
  const s = Array.isArray(slots) ? slots.find((x) => x && x.index === 0) : null;
  if (!s || !s.present) return null;
  const m = String(s.color || "").trim().toLowerCase().match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/);
  return m ? "#" + m[1] : null;
}

/* Filament accent: the spool's color, darkened (light mode) or lightened
   (dark mode) just enough to stand out from the page (3:1) — a white
   spool on a light page, a black one on a dark page; `fallback` without a
   spool. */
function filamentAccent(spool, mode, page, fallback) {
  const c = spool ? parseColor(spool) : null;
  if (!c) return fallback;
  const bg = parseColor(page) || (mode === "dark" ? [0, 0, 0, 1] : [255, 255, 255, 1]);
  const to = mode === "dark" ? 255 : 0;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const rgb = c.slice(0, 3).map((v) => v + (to - v) * t);
    if (contrastRatio(rgb, bg) >= 3) return toHex(rgb);
  }
  return fallback;
}

/* Filament: the surfaces take a touch of the spool's color — the page,
   the cards and sheets a little, the sidebar a little more. Translucent
   surfaces keep their alpha. */
const FILAMENT_TINT = { "--content-bg": 0.05, "--card-bg": 0.025, "--sheet-bg": 0.04, "--sidebar-opaque": 0.1, "--sidebar-bg": 0.1, "--thumb-bg": 0 };
function filamentTint(tokens, spool) {
  const c = spool ? parseColor(spool) : null;
  if (!c) return {};
  const out = {};
  for (const [k, w] of Object.entries(FILAMENT_TINT)) {
    const base = parseColor(tokens[k] || "");
    if (!base || !w) continue;
    // The spool brought to the surface's lightness first: only its hue
    // tints (a black spool does not darken a light page).
    const L = luminance(base);
    let tint = c.slice(0, 3);
    for (let t = 0; t <= 1.0001; t += 0.02) {
      tint = c.slice(0, 3).map((v) => v + ((L > 0.18 ? 255 : 0) - v) * t);
      if (L > 0.18 ? luminance(tint) >= L : luminance(tint) <= L) break;
    }
    const rgb = base.slice(0, 3).map((v, i) => v + (tint[i] - v) * w);
    out[k] = base[3] < 1 ? `rgba(${rgb.map(Math.round).join(", ")}, ${base[3]})` : toHex(rgb);
  }
  return out;
}

/* Text on an accent: white, as on macOS, unless the accent is too light
   for it (yellow, orange, light blue…): then near-black. */
const accentTextFor = (rgb) => (contrastRatio(rgb, [255, 255, 255]) >= 3 ? "#ffffff" : "#1d1d1f");

/* ------------------------------------------------------------ applying */

let DISPLAY = DISPLAY_DEFAULT;
/* Spool on T0 of the active printer (Filament theme), remembered so the
   first paint has it before the printer answers. */
const DISPLAY_SPOOL_KEY = "snapstudio.display.spool";
let DISPLAY_SPOOL = null;
let displayApplied = [];
let displayLast = "";

function displayLoad() {
  try {
    return displayNormalize(JSON.parse(localStorage.getItem(DISPLAY_KEY) || "null"));
  } catch {
    return { ...DISPLAY_DEFAULT };
  }
}

const displaySystemDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/* A CSS color expression resolved by the browser (AccentColor, var()…),
   as "rgb(…)". Works in <head>, before <body> exists. */
function cssColor(expr) {
  const probe = document.createElement("i");
  probe.style.color = expr;
  probe.style.display = "none";
  (document.body || document.documentElement).appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

/* Applies settings to <html>; fires "themechange" when the result
   changed, and aligns the native window (title bar, vibrancy). */
function displayApply(s = DISPLAY) {
  DISPLAY = displayNormalize(s);
  const root = document.documentElement;
  const mode = displayResolveMode(DISPLAY.mode, displaySystemDark());
  root.dataset.scheme = mode;
  root.dataset.theme = DISPLAY.theme;
  for (const k of displayApplied) root.style.removeProperty(k);
  const tokens = displayTokens(DISPLAY, mode, DISPLAY_SPOOL);
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  const rgb = parseColor(cssColor("var(--accent)")) || [0, 122, 255];
  root.style.setProperty("--accent-text", accentTextFor(rgb));
  displayApplied = [...Object.keys(tokens), "--accent-text"];
  displayNative();
  const sig = JSON.stringify([mode, tokens, rgb]);
  if (sig !== displayLast) {
    const first = !displayLast;
    displayLast = sig;
    if (!first) window.dispatchEvent(new Event("themechange"));
  }
}

function displaySet(patch) {
  const next = displayNormalize({ ...DISPLAY, ...patch });
  localStorage.setItem(DISPLAY_KEY, JSON.stringify(next));
  displayApply(next);
}

/* A forced mode also forces the window's appearance (macOS title bar
   and vibrancy, Windows title bar); System gives it back to the OS. */
let displayNativeMode;
function displayNative() {
  const want = DISPLAY.mode === "system" ? null : DISPLAY.mode;
  if (want === displayNativeMode) return;
  displayNativeMode = want;
  try {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    // Back to System: until the window has dropped the forced appearance,
    // prefers-color-scheme still reports it, so the mode resolved just
    // before may be the forced one. Resolve it again once it is done.
    win?.setTheme?.(want)?.then?.(() => want === null && displayApply())?.catch?.(() => {});
  } catch {}
}

const isDark = () => document.documentElement.dataset.scheme === "dark";

/* Follows the spool on T0 of the printer Prepare uses (heads.js), as it is
   read or changed. A printer not read yet keeps the remembered color;
   no printer at all (`listed`: the list is known) or an empty T0 gives the
   neutral accent. */
function displaySpoolSync(listed = false) {
  if (typeof headsActive !== "function") return;
  const pid = headsActive();
  const slots = pid ? headsSlots(pid) : [];
  if (pid && !slots.length) return;
  if (!pid && !listed) return;
  const c = pid ? spoolT0(slots) : null;
  if (c === DISPLAY_SPOOL) return;
  DISPLAY_SPOOL = c;
  try {
    c ? localStorage.setItem(DISPLAY_SPOOL_KEY, c) : localStorage.removeItem(DISPLAY_SPOOL_KEY);
  } catch {}
  if (themeById(DISPLAY.theme).accentFrom === "spool") displayApply();
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  try {
    DISPLAY_SPOOL = spoolT0([{ index: 0, present: true, color: localStorage.getItem(DISPLAY_SPOOL_KEY) }]);
  } catch {}
  displayApply(displayLoad());
  window.addEventListener("headschange", () => displaySpoolSync());
  // System mode follows the OS as it changes.
  if (typeof matchMedia === "function") {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (DISPLAY.mode === "system") displayApply();
    });
  }
  // Another window of the app changed the settings.
  window.addEventListener("storage", (e) => e.key === DISPLAY_KEY && displayApply(displayLoad()));
}

if (typeof module !== "undefined") {
  module.exports = {
    DISPLAY_DEFAULT, DISPLAY_MODES, ACCENTS, THEMES, CVD_TOKENS, themeById, filamentTint, displayNormalize, displayResolveMode, displayAccent,
    displayTokens, parseColor, blendOver, contrastRatio, accentTextFor, spoolT0, filamentAccent, toHex,
  };
}
