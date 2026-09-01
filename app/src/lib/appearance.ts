// Runtime appearance helpers: apply the user's accent color and motion
// preference to the document so they take effect immediately and on boot.
//
// DESIGN.md ships a single electric-yellow voltage by default; the accent
// picker is an explicit user-facing preference layered on top of it.

/** A selectable accent color shown as a swatch in Settings. */
export interface AccentPreset {
  id: string;
  label: string;
  value: string;
}

/** The default Hampy voltage plus the pastel family + white. */
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "voltage", label: "Voltage (default)", value: "#faff69" },
  { id: "pink", label: "Pastel pink", value: "#ffadcd" },
  { id: "blue", label: "Pastel blue", value: "#a9d3ff" },
  { id: "green", label: "Pastel green", value: "#aef2c5" },
  { id: "red", label: "Pastel red", value: "#ff9b9b" },
  { id: "purple", label: "Pastel purple", value: "#cdb8ff" },
  { id: "orange", label: "Pastel orange", value: "#ffce9e" },
  { id: "white", label: "White", value: "#ffffff" },
];

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear blend of two colors; t=0 → a, t=1 → b. */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Set `--color-primary` and its derived hover/disabled shades from a single
 * accent hex. The accents are all light, so on-primary text stays dark.
 */
export function applyAccent(hex: string): void {
  const valid = /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex);
  const color = valid ? hexToRgb(hex) : hexToRgb("#faff69");
  const root = document.documentElement.style;
  root.setProperty("--color-primary", rgbToHex(color));
  // Hover/active: nudge ~12% toward black for a pressed feel.
  root.setProperty("--color-primary-active", rgbToHex(mix(color, [0, 0, 0], 0.12)));
  // Disabled: mostly blended into the card surface so it reads as inert.
  root.setProperty("--color-primary-disabled", rgbToHex(mix(color, [26, 26, 26], 0.78)));
  // Consumers that can't read CSS vars directly (xterm.js theme objects) listen for this.
  window.dispatchEvent(new Event("hampy:accent-changed"));
}

/** Toggle UI motion globally; off adds a root flag CSS uses to kill transitions. */
export function applyAnimations(enabled: boolean): void {
  document.documentElement.dataset.animations = enabled ? "on" : "off";
}
