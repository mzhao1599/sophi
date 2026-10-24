# Design screenshots

Before-and-after screenshots for the October 2026 redesign of `apps/web`, referenced from the pull
requests. They were taken by the taste-skill inspector (`inspect.mjs`) from a local development
server, so a small "N" badge in the corner is Next.js's development indicator, not part of the page.
The "scroll" images are the inspector's contact sheets: four screens of the page in reading order,
left to right and top to bottom. Full-size originals are regenerated into `.taste-skill/before` and
`.taste-skill/after` (both git-ignored) by running the inspector.

## Steady (October 2026)

`steady-*.jpg` are the Steady redesign of the one-page demo, taken from the development previews
(`/dev/preview/{start,chat,walker,order}`, the deterministic engine answering the demo persona's lines)
through the inspector's Chrome driver: at 1440 by 900; at `200pct` (720 by 450 CSS pixels at twice
the pixel density, as 200% zoom on a 1440 by 900 screen); and with `reduced-motion` emulated. The
`panel-*` shots open a part's panel by pressing its button on the drawing. `steady-order-1440.jpg` is
the success page's design with placeholder demo prices; a real order is only read from Stripe.
