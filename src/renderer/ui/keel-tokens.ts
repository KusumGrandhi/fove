/**
 * Keel's design tokens, from the handoff.
 *
 * Deliberately *not* fove's theme. Keel is a distinct surface with its own
 * visual language — the handoff specifies exact surfaces, inks and a type
 * scale, and the earlier attempt at this screen quietly substituted fove's
 * tokens and lost the design. These are the handoff's values verbatim so that
 * substitution cannot happen by accident again.
 *
 * The consequence, accepted: Keel does not follow the app theme. It is dark
 * whatever fove is set to, because the palette below is a designed set rather
 * than a set of roles, and reskinning it per theme would be inventing five
 * more palettes nobody specified.
 */

/** Surfaces. Onyx page, raised panel, inset panel. */
export const SURFACE = {
  /** Page and card shell. */
  s0: "#0F0F16",
  /** Raised panel, card interior. */
  s1: "#16161F",
  /** Inset panel, rail background, table rows. */
  s2: "#12121A",
} as const;

export const BORDER = {
  /** Hairline. */
  b1: "rgba(210,204,192,.10)",
  /** Panel divider. */
  b2: "rgba(210,204,192,.13)",
} as const;

/**
 * Ink on dark.
 *
 * `ink5` is the floor and is reserved for non-load-bearing labels. The handoff
 * is explicit that anything a reader must actually read sits at `ink4` or
 * above, and that this rule came from two rounds of measured contrast defects.
 */
export const INK = {
  i1: "#FDFDFC",
  i2: "rgba(253,253,252,.78)",
  i3: "rgba(253,253,252,.62)",
  i4: "rgba(253,253,252,.55)",
  i5: "rgba(253,253,252,.32)",
} as const;

/**
 * Brand and state.
 *
 * `brand` is for fills, dots and borders only. `#5251FD` at small sizes on
 * `#16161F` measures 3.38:1 and fails, so brand-coloured *text* uses
 * `brandText` — the handoff calls this out specifically.
 */
export const BRAND = {
  brand: "#5251FD",
  brandText: "#8180FE",
  wash: "rgba(82,81,253,.14)",
  edge: "rgba(82,81,253,.35)",
} as const;

export const STATE = {
  good: "color-mix(in srgb, #0F8A0F 50%, #FDFDFC)",
  warn: "#FF8F2E",
  bad: "color-mix(in srgb, #A10D0F 45%, #FDFDFC)",
  goodWash: "rgba(15,138,15,.08)",
  goodEdge: "rgba(15,138,15,.28)",
  warnWash: "rgba(255,143,46,.10)",
  warnEdge: "rgba(255,143,46,.28)",
  badWash: "rgba(161,13,15,.13)",
  badEdge: "rgba(161,13,15,.42)",
} as const;

/**
 * Typefaces.
 *
 * Bundled rather than loaded from Google Fonts: a packaged Electron app has no
 * network, and a `<link>` to fonts.googleapis.com would fall back to system-ui
 * silently — the design would be wrong in a way that is hard to notice.
 * Verified absent from this machine's 313 installed families before choosing
 * to bundle.
 */
export const FONT = {
  product: "'DM Sans', system-ui, -apple-system, sans-serif",
  mono: "'IBM Plex Mono', Menlo, monospace",
} as const;

export const SHADOW = {
  card: "0 8px 30px rgba(15,15,22,.14)",
  brand: "0 4px 14px rgba(82,81,253,.30)",
} as const;

/** The handoff's type scale, as ready-made style objects. */
export const TYPE = {
  /** Titles: 700 weight, tight tracking. */
  title22: { fontFamily: FONT.product, fontSize: 22, fontWeight: 700, letterSpacing: "-0.015em" },
  title17: { fontFamily: FONT.product, fontSize: 17, fontWeight: 700, letterSpacing: "-0.015em" },
  title15: { fontFamily: FONT.product, fontSize: 15, fontWeight: 700, letterSpacing: "-0.015em" },
  /** Body: 400 weight, 1.5–1.6 line height. */
  body135: { fontFamily: FONT.product, fontSize: 13.5, lineHeight: 1.6 },
  body125: { fontFamily: FONT.product, fontSize: 12.5, lineHeight: 1.55 },
  body115: { fontFamily: FONT.product, fontSize: 11.5, lineHeight: 1.5 },
  /** Eyebrow: 9.5px, .09em, uppercase, 500. */
  eyebrow: {
    fontFamily: FONT.mono, fontSize: 9.5, fontWeight: 500,
    letterSpacing: "0.09em", textTransform: "uppercase" as const,
  },
  /** Mono, for paths, signatures and metrics. */
  mono125: { fontFamily: FONT.mono, fontSize: 12.5 },
  mono115: { fontFamily: FONT.mono, fontSize: 11.5, lineHeight: 1.5 },
  mono11: { fontFamily: FONT.mono, fontSize: 11 },
  mono105: { fontFamily: FONT.mono, fontSize: 10.5 },
} as const;

/** Radii, from the handoff: pill / card / inner box / chip. */
export const RADIUS = { pill: 999, card: 12, box: 9, chip: 6 } as const;

/**
 * Strip IDE context the editor prepends to a prompt.
 *
 * `<ide_selection>` wraps the code you had highlighted. It is genuinely part of
 * the turn, so `turns.ts` keeps it -- but it is context rather than the
 * question, and 400 characters of Python where the task should be makes the
 * rail unreadable. Shared by both Keel views because the first version of this
 * lived in one of them and the other leaked raw markup.
 */
export function cleanPrompt(text: string): string {
  const stripped = text
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
  return stripped || text.slice(0, 200);
}
