/**
 * Themes.
 *
 * A theme is a flat set of colour tokens. Panes read them through CSS custom
 * properties rather than importing values, so switching a theme repaints the
 * app without remounting anything — which matters here, because remounting a
 * pane would tear down its PTY and lose a running `claude` session.
 *
 * The `C` object other files already import stays valid: its members resolve
 * to `var(--fove-*)`, so existing styles pick up the active theme with no
 * change at the call site.
 */

export interface Theme {
  id: string;
  label: string;
  /** Which xterm/Monaco base to pair with. */
  dark: boolean;
  colors: {
    bg: string;
    chrome: string;
    chromeHi: string;
    panel: string;
    line: string;
    fg: string;
    dim: string;
    faint: string;
    accent: string;
    green: string;
    red: string;
    yellow: string;
  };
}

export const THEMES: Theme[] = [
  {
    id: "midnight",
    label: "Midnight",
    dark: true,
    colors: {
      bg: "#0b0b0f", chrome: "#16161c", chromeHi: "#1e1e26", panel: "#101014",
      line: "#26262f", fg: "#e6e6ea", dim: "#9a9aa3", faint: "#5a5a63",
      accent: "#2f6feb", green: "#3fb950", red: "#e5534b", yellow: "#d29922",
    },
  },
  {
    id: "graphite",
    label: "Graphite",
    dark: true,
    colors: {
      bg: "#131316", chrome: "#1c1c20", chromeHi: "#26262b", panel: "#18181c",
      line: "#2e2e35", fg: "#e8e8ea", dim: "#a0a0a8", faint: "#63636c",
      accent: "#7c8cf8", green: "#4cc38a", red: "#e5484d", yellow: "#f0c000",
    },
  },
  {
    id: "ember",
    label: "Ember",
    dark: true,
    colors: {
      bg: "#0f0c0b", chrome: "#1b1614", chromeHi: "#251d1a", panel: "#141110",
      line: "#302623", fg: "#f0e6e0", dim: "#a89890", faint: "#6b5c56",
      accent: "#e06c3b", green: "#5cb85c", red: "#e5534b", yellow: "#d9a441",
    },
  },
  {
    id: "forest",
    label: "Forest",
    dark: true,
    colors: {
      bg: "#0a0f0c", chrome: "#131a16", chromeHi: "#1b241e", panel: "#0e1411",
      line: "#233029", fg: "#e2ece6", dim: "#93a89c", faint: "#556960",
      accent: "#3fb37f", green: "#4ec97e", red: "#e5675b", yellow: "#d9b441",
    },
  },
  {
    id: "paper",
    label: "Paper",
    dark: false,
    colors: {
      bg: "#f6f6f4", chrome: "#ececea", chromeHi: "#e0e0dd", panel: "#ffffff",
      line: "#d6d6d2", fg: "#1e1e22", dim: "#55555e", faint: "#8a8a92",
      accent: "#2f6feb", green: "#1a7f37", red: "#cf222e", yellow: "#9a6700",
    },
  },
];

export const DEFAULT_THEME = "midnight";

/** Apply a theme by writing its tokens as CSS variables on :root. */
export function applyTheme(id: string): Theme {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]!;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--fove-${key}`, value);
  }
  // Native form controls and scrollbars follow this.
  root.style.colorScheme = theme.dark ? "dark" : "light";
  return theme;
}

/**
 * The token names, as `var()` references.
 *
 * Every pane already imports `C`, so routing it through variables is what lets
 * a theme change repaint live panes without a remount.
 */
export const TOKENS = {
  bg: "var(--fove-bg)",
  chrome: "var(--fove-chrome)",
  chromeHi: "var(--fove-chromeHi)",
  panel: "var(--fove-panel)",
  line: "var(--fove-line)",
  fg: "var(--fove-fg)",
  dim: "var(--fove-dim)",
  faint: "var(--fove-faint)",
  accent: "var(--fove-accent)",
  green: "var(--fove-green)",
  red: "var(--fove-red)",
  yellow: "var(--fove-yellow)",
} as const;

/** Resolve a token to its literal value, for canvas and xterm which cannot use var(). */
export function resolved(id: string): Theme["colors"] {
  return (THEMES.find((t) => t.id === id) ?? THEMES[0]!).colors;
}
