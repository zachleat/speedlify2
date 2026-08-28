# Local brand marks

Three sources, in order: Font Awesome first for the brands it carries (see
`FONT_AWESOME_ICONS` in `eleventy.config.js` — it emits one spritesheet symbol
per page rather than inlining the same path on every row), then this directory,
then simple-icons.

Color comes from simple-icons, which ships a hex with every icon. Font
Awesome's marks are monochrome, so a brand that exists only there needs an entry
in `BRAND_COLORS` beside that map or it follows the theme's text color.

That leaves this directory for brands neither project carries. It is currently
close to empty: Amazon's marks were removed from simple-icons at Amazon's
request, and Font Awesome carries `amazon`, so the case this directory was
created for no longer needs it. A missing file is not an error — the cell falls
back to a two-letter chip.

To add one, drop a single-path SVG in this directory named after the `icon`
value in `lib/stack.js`:

    src/icons/Amazon.svg      ->  icon: "Amazon"

Requirements:

- one `<path d="…">` (the first is used, extra paths are ignored with a warning)
- a square `viewBox`, any size — it is read off the root `<svg>`
- optionally `data-hex="RRGGBB"` on the root `<svg>` for the brand color

Without `data-hex` the mark follows the theme's text color, which is what the
luminance guard does for very dark or very light brands anyway.

Check the license of any mark you add. Most companies permit using their logo
to refer to their own product, but that is not universal, and it is the reason
these are not vendored by default.
