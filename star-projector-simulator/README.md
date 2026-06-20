# ✦ Star Projector Simulator & Design Tool

A 3D simulator **and** design tool for a homemade star projector.

**The physical device:** lay an iPhone face-down on the floor of a dark room,
turn the flashlight (torch) on, and set a small 3D-printed cap over the flash.
Tiny holes in the cap let light through and project a playful star field onto
the ceiling. This tool lets you design that field interactively and then
**export a printable STL** of the cap.

![concept](https://img.shields.io/badge/three.js-WebGL-blue) — single file, no build step.

## Run it

It's one self-contained `index.html`. Just open it in a modern browser:

```bash
# easiest: double-click index.html, or serve it locally
cd star-projector-simulator
python3 -m http.server 8000
# then visit http://localhost:8000
```

> **Needs internet on first load.** Three.js, lil-gui and the CSG library are
> loaded from a CDN (jsDelivr) via an import map. No install/build required.

## What you can do

- **Orbit the room** in 3D, or use the view buttons: *Room view*, *Lie down &
  look up* (the view you'd actually have), and *Side view*.
- **Tune everything with sliders** (top-right panel):
  - **iPhone** — model preset (14/15/16 ± Pro), beam half-angle (FOV), LED
    size, torch brightness, colour temperature, and the flash's offset from the
    phone centre.
  - **Object** — shape (dome / cylinder / cone), base radius, height, wall
    thickness, and aperture size (all in mm).
  - **Star layout** — procedural patterns (scatter, clusters, spiral, Milky-Way
    band, rings), count, seed, spread, density and brightness/size variety.
  - **Aperture shapes** — the mix of cut-out shapes (★ stars, ☾ crescent moons,
    • dots, ✦ sparkles) and whether each is randomly rotated.
  - **Optics** — penumbra / edge blur, brightness falloff, edge vignette, and
    beam-edge softness.
  - **Render** — exposure, bloom/glow, shape size, and toggles for the beam cone,
    sample light rays, and hole markers.
- **Export & share** — download a **printable STL**, save/load all settings as
  JSON, and grab a PNG screenshot.

## How the simulation works

The LED torch is modelled as a small point source sitting at the base of the
cap. The key insight: this is a **gobo / shaped-aperture projection** — each
cut-out (star, moon, dot…) defines a direction from the LED, and the wall shows
a magnified, softly-blurred **image of that shape's silhouette** (just like the
reference photo, where pierced shapes in a metal lamp cast crisp stars and
moons on the walls).

- Position: a hole along direction `d` projects to wherever that ray first hits
  the room — the **ceiling in the centre, the upper walls toward the edges** (a
  ~60° beam in a 2.5 m room is wider than the ceiling, so the field naturally
  wraps onto the walls). Magnification `M = (LED→surface distance) / (LED→hole
  distance)`.
- **Shape size:** each projected shape is `≈ M ×` its aperture size, drawn as a
  flat decal lying on the surface and **stretched along the incidence direction**
  on the walls (grazing angles elongate it, like a real projection).
- **Penumbra / blur:** the finite LED size feathers every shape's edge by
  `≈ M · LED_size`. Bigger LED or magnification → softer edges; a *small* LED on
  a *tall* cap keeps the shapes crisp and recognisable.
- **Brightness falloff:** inverse-square over the LED→surface path length, times
  an off-axis / incidence vignette, so shapes near the beam edge are dimmer.
- **Beam-cone FOV:** the torch only emits within a cone (half-angle from the
  iPhone preset, adjustable). Shapes beyond it fade out at the edge.
- **Colour:** the LED colour-temperature tints the whole field (a warm white by
  default), with gentle per-shape variation.

Star positions, sizes and brightness are computed **analytically** and drawn as
additive glowing points — not via GPU shadow casting. This is far faster and
more controllable, and accurate enough for this device. The 3D cap you see is a
smooth shell with hole markers; the STL export punches the real holes.

### STL export

The cap is built as a closed manifold surface of revolution (dome/cylinder/cone
shell with a wall and a small flat top). For every realisable shape, a matching
**shaped prism** (star / crescent / circle / sparkle) is drilled along that
shape's ray direction and subtracted from the shell using
[`three-bvh-csg`](https://github.com/gkjohnson/three-bvh-csg). The result is
exported in **millimetres**, ready to slice and print. Print it in an opaque
material; the inside should be light-tight except the holes. Hole count for
export is capped at 200 to keep in-browser CSG responsive.

## Assumptions & limitations

- The iPhone flash is treated as a **single small point source**. Apple
  publishes no official beam-angle or lumen specs, so the presets are
  **reasonable estimates** (torch ≈ 40–50 lm, diffuse flood ≈ 58–63° half-angle)
  and everything is adjustable.
- A few stars within a few degrees of straight-up may be "not realisable" — the
  cap has a tiny flat top, so the very zenith isn't a clean hole. Widen the
  object or reduce *spread* if you want more central coverage.
- Wall thickness is applied radially (good for steep walls; slightly thin near a
  shallow dome top).

### Out of scope (possible future work)
- Real night-sky star catalogue / named constellations (this is procedural).
- True GPU ray-traced shadow projection.
- Pro "Adaptive" multi-segment beam shaping (single point source assumed).

## Tech

Three.js + lil-gui, `EffectComposer`/`UnrealBloomPass` for glow,
`three-bvh-csg` for hole punching, `STLExporter` for output — all via CDN import
map. No bundler, no `node_modules`.
