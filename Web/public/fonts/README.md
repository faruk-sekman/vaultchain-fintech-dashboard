# Self-hosted web fonts

This directory holds the application's two typefaces as self-hosted `.woff2` files — 14 in total.
Serving them from the app itself keeps the Content-Security-Policy free of the Google Fonts CDN
(`fonts.googleapis.com` / `fonts.gstatic.com`): no third-party request, no external origin to
allow, and typography that works offline.

## Inventory

| Family | Role in the UI | Weights | Files |
| ------ | -------------- | ------- | ----- |
| Inter | Body and UI text — the `--font-family-base` token | 300, 400, 500, 600, 700, 800, 900, plus italics at 300 and 400 | 9 |
| Space Grotesk | Brand wordmark and display headings (logo, auth screens) | 300, 400, 500, 600, 700 | 5 |

All files are `latin` + `latin-ext` subsets, which covers both UI languages (English and Turkish).
In the filenames, `-regular` means weight 400, and `v20` / `v22` are the upstream release
snapshots the subsets were packaged from.

## How they are wired

- The `@font-face` rules live in [`_fonts.scss`](../../src/styles/_fonts.scss) and reference these
  exact filenames with `font-display: swap`, so text stays visible while a font loads.
- Angular serves everything under `Web/public/` as-is, so the files resolve at
  `/fonts/<name>.woff2` — adding or replacing a file requires no build configuration change.
- A browser downloads a given file only when a glyph actually renders at that family, weight, and
  style — declaring all 14 does not mean loading all 14.
- If a file is ever missing, the UI falls back to the system stack defined in
  [`_typography.scss`](../../src/styles/_typography.scss):
  `"Inter", system-ui, -apple-system, "Segoe UI", roboto, helvetica, arial, sans-serif`.

To add or change a weight: drop the `.woff2` file here and add the matching `@font-face` rule in
`_fonts.scss`.

## Licensing and attribution

| Typeface | License | Official source |
| -------- | ------- | --------------- |
| Inter | [SIL Open Font License 1.1](https://openfontlicense.org) | [rsms.im/inter](https://rsms.im/inter/) |
| Space Grotesk | [SIL Open Font License 1.1](https://openfontlicense.org) | [github.com/floriankarsten/space-grotesk](https://github.com/floriankarsten/space-grotesk) |

Both typefaces are licensed under the SIL Open Font License 1.1, which permits bundling and
redistributing them with software. The files here are WOFF2 web subsets of the upstream releases;
the designs and names remain those of their respective authors.
