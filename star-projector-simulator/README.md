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
    thickness, and hole diameter (all in mm).
  - **Star layout** — procedural patterns (scatter, clusters, spiral, Milky-Way
    band, rings), star count, seed, spread, density and brightness/size variety.
  - **Optics** — penumbra/blur, brightness falloff, edge vignette, beam-edge
    softness, diffraction sparkle, chromatic fringe.
  - **Render** — exposure, bloom/glow, star size, and toggles for the beam cone,
    sample light rays, and hole markers.
- **Export & share** — download a **printable STL**, save/load all settings as
  JSON, and grab a PNG screenshot.

## How the simulation works

The LED torch is modelled as a small point source sitting at the base of the
cap. The key insight: **each hole defines a direction from the LED**, and the
star lands where that ray meets the ceiling.

- Position: a hole along direction `d` projects to wherever that ray first hits
  the room — the **ceiling in the centre, the upper walls toward the edges** (a
  ~60° beam in a 2.5 m room is wider than the ceiling, so the field naturally
  wraps onto the walls). Magnification `M = (LED→surface distance) / (LED→hole
  distance)`.
- **Penumbra / blur:** because the LED has a finite size, each star is a soft
  spot of diameter ≈ `M · (hole_Ø + LED_size)` (stretched at grazing incidence
  on the walls). Bigger holes, bigger LEDs and taller magnification all make
  softer, larger stars — so a *small* hole on a *tall* cap gives the crispest
  stars.
- **Brightness falloff:** inverse-square over the LED→ceiling path length, times
  a `cos⁴θ` off-axis vignette, so stars near the edge of the beam are dimmer.
- **Beam-cone FOV:** the torch only emits within a cone (half-angle from the
  iPhone preset, adjustable). Stars beyond it fade out at the edge.
- **Diffraction & colour:** small holes add sparkle/spikes and a slight
  chromatic fringe; the LED colour temperature tints the whole field.

Star positions, sizes and brightness are computed **analytically** and drawn as
additive glowing points — not via GPU shadow casting. This is far faster and
more controllable, and accurate enough for this device. The 3D cap you see is a
smooth shell with hole markers; the STL export punches the real holes.

### STL export

The cap is built as a closed manifold surface of revolution (dome/cylinder/cone
shell with a wall and a small flat top). For every realisable star, a cylinder
is drilled along that star's ray direction and subtracted from the shell using
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
