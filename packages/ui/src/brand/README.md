# Wrenly's bird

These two SVGs are the original artwork for Wrenly. For example, changing the
bird here updates the sign-in screen, workspace, landing and documentation
without redrawing it separately in each app.

- `w-icon.svg` is for light backgrounds.
- `w-icon-on-dark.svg` is for dark backgrounds. It has its own geometry as well
  as its own colours; keep both originals intact.

`favicons/` holds the supplied square SVG/PNG originals. `w-favicon-on-light` is the
light browser artwork; `wrenly-favicon` is the dark browser artwork and touch icon.
Keep their canvas, background and spacing intact rather than extracting just the bird.

After replacing either original, run from `packages/ui`:

```bash
bun run brand:sync
```

This regenerates shared path data, theme rules and public copies. Browser favicons
come from the separate square artwork in `favicons/`, preserving its background and
spacing; replacing the animated mark does not replace the favicon design. Both apps
receive a theme-aware SVG favicon and the supplied PNG as their Apple touch icon.
Edit the originals here, then sync, rather than editing generated app copies. The browser icons follow
its colour preference. The application marks follow the selected page theme;
primary buttons choose the opposite palette to match their background.

`../wrenly-mark.tsx` renders the paths as ordinary SVG elements so the large
sign-in illustration can animate individual feathers. The auth illustration and access-check loading bird animate their feathers;
their CSS leaves the body still and honours reduced motion. Primary-action marks retain the supplied shading and transparency at a readable
24px size; their background selects the appropriate supplied artwork.

After an artwork change, also regenerate the landing's social-sharing image:

```bash
bun run --cwd ../../apps/docs social:card
```

From the repository root, that command is `bun run --cwd apps/docs social:card`.
The API has no visual application or favicon; the web and documentation apps do.

## Component design

Purpose: show the same supplied bird on every product surface.
Inputs: an optional CSS class and the background variant (`default` or `on-primary`).
Output: decorative inline SVG; the enclosing control supplies its accessible name.
Steps: generate paths from both originals, select the artwork using the surface's
CSS theme, and expose feather layers for the auth illustration's motion.
Edge cases: explicit light theme overrides the system preference; primary buttons
reverse palettes; reduced-motion users get a still illustration.
Errors: the generator stops on missing geometry, invalid opacity, an unexpected
layer count or mismatched view boxes instead of silently generating broken icons.
