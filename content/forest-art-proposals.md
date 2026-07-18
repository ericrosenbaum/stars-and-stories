# Forest Map — proposed location illustrations

The Forest map (`#/forest`) renders every location with an automatic image
fallback chain: generated art → character vignette / story header → an
illustrated glyph. Locations listed here have **no good existing imagery**, so
a generated illustration would light up both their map marker and their codex
panel.

## How to generate (on the recording Mac)

1. Generate each image with the Gemini image tooling (same model family the
   header/storyboard generators use), using the shared style preamble plus the
   per-location prompt below.
2. Save the picked result as `content/forest-art/<location-id>.png`
   (the filename **is** the wiring — it must match the location id exactly).
3. `cd tools && npm run build` — this optimizes each PNG into
   `site/public/media/forest/<id>.webp` and stamps the location's `art` field
   into `site/public/data/forest.json`.
4. Commit `content/forest-art/` is gitignored territory? No — keep the PNGs
   out of git if large; commit the emitted `site/public/media/forest/*.webp`
   and `site/public/data/forest.json`. The map updates with zero code changes.

## Shared style preamble

> Warm children's-storybook illustration, soft watercolor and colored-pencil
> textures on cream paper, gentle golden daylight, rounded friendly shapes,
> no text, no humans, square composition.

## The proposals

| # | file | prompt (appended to the preamble) |
|---|------|-----------------------------------|
| 1 | `hatties-workshop.png` | A weathered hollow tree stump converted into a cozy hat-maker's workshop: a round wooden door, shelves of tiny colorful hats, glowing red-orange-and-yellow mushroom lamps, a spool table with peanut-butter toast, wisps of cedar-scented chimney smoke. |
| 2 | `underground-library.png` | A cutaway view of a secret library nestled between the roots of an old tree stump: earthen walls, root-beam ceilings, shelves carved into soil holding tiny books, a warm lantern, a small mouse reading. |
| 3 | `discos-basket-house.png` | A cozy woven-basket house glowing from within, underground in a snug burrow: light spilling through the weave like stars, strings of soft lights, a happy little mole silhouette dancing. |
| 4 | `gopher-tunnels.png` | An ant-farm cutaway of a friendly gopher tunnel labyrinth: branching earthen passages, a snug den where a gopher family waves over tea and carrots, roots dangling from the tunnel ceilings. |
| 5 | `peacocks-castle.png` | A gray stone castle with tall turrets crowning a green hill, and atop the highest tower a huge cozy bird's nest with iridescent peacock feathers trailing in the breeze. |
| 6 | `mama-foxes-burrow.png` | A hillside fox den with a round earthen doorway, its dark cozy interior dotted with glowing star stickers on the walls, a sleepy fox curled inside. |
| 7 | `kingdom-of-blind-mice.png` | A grand but tiny underground throne chamber lit by lanterns: gentle mice with walking canes, moss banners on packed-earth walls, tunnel doorways leading off in every direction. |
| 8 | `christmas-tree-mountain.png` | A mountain shaped from stacked evergreen trees like a giant Christmas tree, one shiny bunny ornament glinting beside a small hidden wooden door at its base. |
| 9 | `the-pond.png` | A sunny woodland swimming hole with a little wooden dock, smooth sun-bleached shells scattered on the bank, dragonflies over sparkling water, lily pads. |
| 10 | `auntie-mulberrys-cottage.png` | A snug cottage deep in the forest with a round mulberry-purple front door, a pie cooling on the windowsill, hollyhocks by the path, a plump bunny in an apron waving. |
| 11 | `seekers-castle.png` | A glowing castle at the edge of the forest where the trees thin out: warm windows, a tall tower, and through an open door a glimpse of a closet lined with shimmering potion bottles. |
| 12 | `the-mountain.png` | A muddy brown mountain with secret holes and winding hidden tunnels peeking through its face, and a small mysterious wooden door tucked around the back. |

Reserve ideas (if the batch goes well): `river-lake.png` (Mossy the moss
creature on the Sunlit Rock), `honey-tree.png` (a towering tree dripping with
golden honey beside Cornell Street), `deep-dark-forest.png` (thick friendly
darkness, lantern glow between the trunks, two glowing eyes that are only a
friend).
