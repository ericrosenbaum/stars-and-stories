/* ================= The Stars & Stories Forest — map engine =================
   Framework-agnostic. mountForest(root, data, resolveImage) builds the whole
   interactive storybook map inside `root` and returns a cleanup function.
     - data: the forest.json document ({ meta, locations, paths }).
     - resolveImage(loc, field) -> image URL or null, field in
       "art" | "image" | "vignette" (site: assetUrl(loc[field])).
   Sibling of orrery.js (the cosmology engine): same camera, codex, and legend
   patterns, but a daylight parchment world with a soil cutaway underneath. */

export function mountForest(root, data, resolveImage) {
  var SVGNS = "http://www.w3.org/2000/svg";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  resolveImage = resolveImage || function () { return null; };

  var ZONE = {
    canopy:      { raw: "#4f7a43", label: "Treetops & Nests" },
    surface:     { raw: "#6c9147", label: "Forest Floor" },
    water:       { raw: "#4f89ab", label: "Ponds & Streams" },
    landmark:    { raw: "#a8783f", label: "Hills & Castles" },
    underground: { raw: "#8a5f3c", label: "Down in the Burrows" }
  };
  var ZONE_ORDER = ["canopy", "surface", "water", "landmark", "underground"];
  // Which legend zone dims/undims each linear feature kind when filtering.
  var KIND_ZONE = { road: "surface", trail: "surface", river: "water", stream: "water", tunnel: "underground" };

  var meta = data.meta || {};
  var canvas = meta.canvas || { width: 1000, height: 1400, groundY: 1000 };
  var CW = canvas.width, CH = canvas.height, GY = canvas.groundY;
  var locations = data.locations.slice();
  var paths = (data.paths || []).slice();

  // ---------- tiny helpers ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function fmtDate(d) {
    if (!d) return "";
    try { return new Date(d).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" }); }
    catch (e) { return ""; }
  }
  // Deterministic PRNG so the hand-drawn scatter is stable between visits.
  function prng(seed) {
    var h = 2166136261;
    for (var i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return function () {
      h += 0x6d2b79f5;
      var t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Closed wobbly blob path around (cx,cy) — ponds, canopies, hills.
  function blobPath(cx, cy, rx, ry, seed, wob) {
    var rand = prng(seed), n = 10, pts = [];
    wob = wob == null ? 0.22 : wob;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2;
      var k = 1 - wob / 2 + rand() * wob;
      pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
    }
    var d = "M " + pts[0][0].toFixed(1) + "," + pts[0][1].toFixed(1);
    for (i = 0; i < n; i++) {
      var p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      // Catmull-Rom -> cubic bezier for a soft hand-drawn outline.
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += " C " + c1x.toFixed(1) + "," + c1y.toFixed(1) + " " + c2x.toFixed(1) + "," + c2y.toFixed(1) + " " + p2[0].toFixed(1) + "," + p2[1].toFixed(1);
    }
    return d + " Z";
  }

  // ---------- shell ----------
  root.classList.add("forest-map");
  root.innerHTML =
    '<div class="stage"></div>' +
    '<header class="masthead">' +
      '<p class="eyebrow">A Woodland Atlas</p>' +
      '<h1>' + esc(meta.title || "The Forest") + '</h1>' +
      '<p class="sub">' + esc(meta.subtitle || "") + '</p>' +
    '</header>' +
    '<aside class="legend" aria-label="Legend"><h2>The Territories</h2><ul class="legend-list"></ul></aside>' +
    '<div class="hint">Scroll to zoom · drag to wander · tap a place ❧</div>' +
    '<p class="credit">' + esc(meta.note || "") + '</p>' +
    '<div class="scrim" hidden></div>' +
    '<aside class="codex" aria-label="Place codex" hidden aria-hidden="true"></aside>';

  var stage = root.querySelector(".stage");
  var codex = root.querySelector(".codex");
  var scrim = root.querySelector(".scrim");
  var hint = root.querySelector(".hint");
  var legendList = root.querySelector(".legend-list");

  var svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "woodland");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  stage.appendChild(svg);
  function el(name, attrs) {
    var e = document.createElementNS(SVGNS, name);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  var defs = el("defs"); svg.appendChild(defs);
  function addGrad(kind, id, stops, attrs) {
    var g = el(kind, Object.assign({ id: id }, attrs || {}));
    stops.forEach(function (s) { g.appendChild(el("stop", { offset: s[0], "stop-color": s[1], "stop-opacity": s[2] == null ? 1 : s[2] })); });
    defs.appendChild(g);
  }

  // ---------- defs: gradients, halos, paper grain ----------
  addGrad("linearGradient", "fSky", [["0%", "#f9edcf"], ["70%", "#f7efdb"], ["100%", "#f3ecd6", 0]], { x1: 0, y1: 0, x2: 0, y2: 1 });
  addGrad("linearGradient", "fHillFar", [["0%", "#dfe3bd"], ["78%", "#dfe3bd", 0.85], ["100%", "#dfe3bd", 0]], { x1: 0, y1: 0, x2: 0, y2: 1 });
  addGrad("linearGradient", "fHillNear", [["0%", "#d3dcae"], ["78%", "#d3dcae", 0.9], ["100%", "#d3dcae", 0]], { x1: 0, y1: 0, x2: 0, y2: 1 });
  addGrad("linearGradient", "fSoil", [["0%", "#a97c50"], ["30%", "#8a5f3c"], ["100%", "#4a3220"]], { x1: 0, y1: 0, x2: 0, y2: 1 });
  addGrad("radialGradient", "fSun", [["0%", "#fff3cd", 0.95], ["55%", "#f6d98a", 0.4], ["100%", "#f6d98a", 0]]);
  addGrad("radialGradient", "fBasketGlow", [["0%", "#ffe9a8", 0.85], ["60%", "#f2c469", 0.3], ["100%", "#f2c469", 0]]);
  ZONE_ORDER.forEach(function (z) {
    addGrad("radialGradient", "fHalo-" + z, [["0%", ZONE[z].raw, 0.5], ["60%", ZONE[z].raw, 0.18], ["100%", ZONE[z].raw, 0]]);
  });
  // Paper tooth — a whisper of fractal noise over the whole page.
  var paper = el("filter", { id: "fPaper", x: "0%", y: "0%", width: "100%", height: "100%" });
  paper.appendChild(el("feTurbulence", { type: "fractalNoise", baseFrequency: "0.8", numOctaves: "2", result: "n", seed: "7" }));
  paper.appendChild(el("feColorMatrix", { in: "n", type: "matrix", values: "0 0 0 0 0.45 0 0 0 0 0.36 0 0 0 0 0.22 0 0 0 0.06 0" }));
  defs.appendChild(paper);
  // A gentle wobble for roads and waterways, so strokes read hand-inked.
  var wob = el("filter", { id: "fWobble", x: "-8%", y: "-8%", width: "116%", height: "116%" });
  wob.appendChild(el("feTurbulence", { type: "fractalNoise", baseFrequency: "0.012", numOctaves: "2", result: "w", seed: "11" }));
  wob.appendChild(el("feDisplacementMap", { in: "SourceGraphic", in2: "w", scale: "6" }));
  defs.appendChild(wob);

  // ---------- layers ----------
  var layerGround = el("g"), layerWater = el("g", { filter: "url(#fWobble)" }),
      layerRoads = el("g", { filter: "url(#fWobble)" }), layerTrees = el("g"),
      layerDecor = el("g"), layerSoil = el("g"), layerTunnels = el("g", { filter: "url(#fWobble)" }),
      layerMarkers = el("g"), layerLabels = el("g");
  [layerGround, layerWater, layerRoads, layerTrees, layerDecor, layerSoil, layerTunnels, layerMarkers, layerLabels]
    .forEach(function (g) { svg.appendChild(g); });

  function locById(id) { return locations.find(function (l) { return l.id === id; }); }
  function radiusOf(loc) { return loc.size === "major" ? 26 : 16; }

  // ---------- ground: parchment, sky, hills, sun, meadows ----------
  layerGround.appendChild(el("rect", { x: -80, y: -80, width: CW + 160, height: CH + 160, fill: "#f3ecd6" }));
  layerGround.appendChild(el("rect", { x: -80, y: -80, width: CW + 160, height: 320, fill: "url(#fSky)" }));
  layerGround.appendChild(el("circle", { cx: 72, cy: 66, r: 84, fill: "url(#fSun)" }));
  layerGround.appendChild(el("circle", { cx: 72, cy: 66, r: 26, fill: "#f9dd8f", stroke: "#eec36a", "stroke-width": 2 }));
  // Distant hills along the top (gradient fills fade out, no hard band edge).
  layerGround.appendChild(el("path", { d: "M -80,235 C 140,150 320,215 520,175 S 830,120 1080,190 L 1080,400 L -80,400 Z", fill: "url(#fHillFar)", opacity: 0.85 }));
  layerGround.appendChild(el("path", { d: "M -80,268 C 180,215 420,258 640,222 S 900,196 1080,248 L 1080,440 L -80,440 Z", fill: "url(#fHillNear)", opacity: 0.9 }));
  // A few slow clouds.
  [["cl1", 300, 92, 1], ["cl2", 640, 60, 0.8], ["cl3", 940, 110, 0.7]].forEach(function (c) {
    var g = el("g", { opacity: 0.75 });
    g.appendChild(el("ellipse", { cx: c[1], cy: c[2], rx: 46 * c[3], ry: 14 * c[3], fill: "#fdf8ea" }));
    g.appendChild(el("ellipse", { cx: c[1] - 24 * c[3], cy: c[2] + 6 * c[3], rx: 28 * c[3], ry: 10 * c[3], fill: "#fdf8ea" }));
    g.appendChild(el("ellipse", { cx: c[1] + 26 * c[3], cy: c[2] + 5 * c[3], rx: 24 * c[3], ry: 9 * c[3], fill: "#fdf8ea" }));
    layerGround.appendChild(g);
  });
  // Near hills that hold the hilltop landmarks.
  layerGround.appendChild(el("path", { d: blobPath(870, 235, 200, 90, "hill-peacock", 0.12), fill: "#cbd6a4" }));
  layerGround.appendChild(el("path", { d: blobPath(120, 400, 170, 95, "hill-fox", 0.14), fill: "#cfd8a8" }));
  // Meadow washes around the open, sunlit places.
  [["meadow-1", 400, 545, 190, 110, "#e9edcb"],
   ["meadow-2", 330, 700, 150, 90, "#e3e9c0"],
   ["meadow-3", 330, 850, 170, 100, "#e9edcb"],
   ["meadow-4", 560, 730, 150, 95, "#e3e9c0"]].forEach(function (m) {
    layerGround.appendChild(el("path", { d: blobPath(m[1], m[2], m[3], m[4], m[0], 0.2), fill: m[5], opacity: 0.85 }));
  });
  // Paper grain across everything painted so far.
  layerGround.appendChild(el("rect", { x: -80, y: -80, width: CW + 160, height: CH + 160, filter: "url(#fPaper)", opacity: 0.8, "pointer-events": "none" }));

  // ---------- water bodies (one blob per water-zone location) ----------
  locations.forEach(function (loc) {
    if (loc.zone !== "water" || loc.body === false) return; // body:false = linear water (river/stream markers)
    var big = loc.size === "major";
    var rx = big ? 88 : 62, ry = big ? 56 : 40;
    layerWater.appendChild(el("path", { d: blobPath(loc.x, loc.y, rx + 5, ry + 5, loc.id + "-shore"), fill: "#c9bd93", opacity: 0.7 }));
    layerWater.appendChild(el("path", { d: blobPath(loc.x, loc.y, rx, ry, loc.id), fill: "#8fbdd6", stroke: "#4f89ab", "stroke-width": 2.5, class: "waterbody", "data-kind": "water" }));
    layerWater.appendChild(el("path", { d: blobPath(loc.x, loc.y, rx * 0.55, ry * 0.5, loc.id + "-inner"), fill: "#a9d0e3", opacity: 0.8 }));
    // Ripple smiles.
    var rand = prng(loc.id + "-ripple");
    for (var i = 0; i < 3; i++) {
      var px = loc.x - rx * 0.4 + rand() * rx * 0.8, py = loc.y - ry * 0.3 + rand() * ry * 0.6, w = 12 + rand() * 10;
      layerWater.appendChild(el("path", { d: "M " + px + "," + py + " q " + (w / 2) + ",5 " + w + ",0", fill: "none", stroke: "#e6f2f7", "stroke-width": 2, "stroke-linecap": "round", opacity: 0.9 }));
    }
  });

  // ---------- linear features (roads, rivers, streams above ground) ----------
  var pathEls = []; // for filtering: {els, zone}
  paths.forEach(function (p) {
    if (p.kind === "tunnel") return; // drawn later, in the soil
    var els = [];
    if (p.kind === "river" || p.kind === "stream") {
      var w1 = p.kind === "river" ? 15 : 9, w2 = p.kind === "river" ? 9 : 5;
      els.push(el("path", { d: p.d, fill: "none", stroke: "#4f89ab", "stroke-width": w1, "stroke-linecap": "round", opacity: 0.85 }));
      els.push(el("path", { d: p.d, fill: "none", stroke: "#8fbdd6", "stroke-width": w2, "stroke-linecap": "round" }));
      els.push(el("path", { d: p.d, fill: "none", stroke: "#e6f2f7", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-dasharray": "1 16", opacity: 0.9 }));
      els.forEach(function (e) { layerWater.appendChild(e); });
    } else {
      var rw = p.kind === "trail" ? 7 : 15;
      var under = el("path", { d: p.d, fill: "none", stroke: "#c9b083", "stroke-width": rw + 3, "stroke-linecap": "round", opacity: 0.6 });
      var over = el("path", { d: p.d, fill: "none", stroke: "#dcc697", "stroke-width": rw, "stroke-linecap": "round" });
      els.push(under, over);
      layerRoads.appendChild(under); layerRoads.appendChild(over);
      if (p.kind === "road") {
        var mid = el("path", { d: p.d, fill: "none", stroke: "#b89a63", "stroke-width": 1.8, "stroke-dasharray": "9 11", "stroke-linecap": "round", opacity: 0.9 });
        els.push(mid); layerRoads.appendChild(mid);
      }
    }
    // Invisible copy for textPath labels + proximity sampling.
    var ref = el("path", { id: "fp-" + p.id, d: p.d, fill: "none", stroke: "none" });
    layerRoads.appendChild(ref);
    pathEls.push({ els: els, zone: KIND_ZONE[p.kind] || "surface", ref: ref, p: p });
  });

  // ---------- tree scatter (procedural, deterministic, content-aware) ----------
  function tree(x, y, s, variant) {
    var g = el("g", { class: "tree" });
    if (variant === "pine") {
      g.appendChild(el("rect", { x: x - 2.4 * s, y: y - 4 * s, width: 4.8 * s, height: 10 * s, rx: 2 * s, fill: "#8a6543" }));
      [[26, 0], [21, 9], [15, 17]].forEach(function (t) {
        g.appendChild(el("path", {
          d: "M " + x + "," + (y - (34 - t[1]) * s) + " L " + (x - t[0] * 0.42 * s) + "," + (y - (8 + t[1] * 0.5) * s) + " Q " + x + "," + (y - (4 + t[1] * 0.5) * s) + " " + (x + t[0] * 0.42 * s) + "," + (y - (8 + t[1] * 0.5) * s) + " Z",
          fill: "#48713f", stroke: "#3c5f35", "stroke-width": 0.8
        }));
      });
    } else {
      var dark = variant === "dark";
      var c1 = dark ? "#3f5c38" : "#6f9a55", c2 = dark ? "#354e30" : "#5f8a48";
      g.appendChild(el("rect", { x: x - 2 * s, y: y - 6 * s, width: 4 * s, height: 9 * s, rx: 1.6 * s, fill: dark ? "#6d4f35" : "#8a6543" }));
      g.appendChild(el("path", { d: blobPath(x, y - 15 * s, 11 * s, 10 * s, "t" + x + "-" + y, 0.26), fill: c1, stroke: c2, "stroke-width": 1 }));
      g.appendChild(el("circle", { cx: x - 4 * s, cy: y - 12 * s, r: 5.5 * s, fill: c1 }));
      g.appendChild(el("circle", { cx: x + 4.5 * s, cy: y - 13 * s, r: 5 * s, fill: c2, opacity: 0.75 }));
    }
    return g;
  }
  // Sample road/river points so trees keep off the ink.
  var avoidPts = [];
  pathEls.forEach(function (pe) {
    try {
      var L = pe.ref.getTotalLength();
      for (var d = 0; d <= L; d += 26) { var pt = pe.ref.getPointAtLength(d); avoidPts.push([pt.x, pt.y]); }
    } catch (e) { /* not attached yet — fine, scatter still works */ }
  });
  var deepDark = locById("deep-dark-forest");
  var pineLoc = locById("pine-tree");
  var rand = prng("the-forest-scatter");
  var placed = [];
  for (var gy = 235; gy < GY - 34; gy += 40) {
    for (var gx = 24; gx < CW - 16; gx += 40) {
      var x = gx + rand() * 30 - 15, y = gy + rand() * 30 - 15;
      var dd = deepDark ? Math.hypot(x - deepDark.x, y - deepDark.y) : 1e9;
      var density = 0.56;
      if (dd < 175) density = 0.94;                      // thicket around the Deep Dark Forest
      if (y < 330 || y > GY - 90) density *= 0.55;       // thin at the hills and the ground line
      if (rand() > density) continue;
      var near = false, i;
      for (i = 0; i < locations.length && !near; i++) {
        var lc = locations[i];
        var keep = lc.zone === "water" ? 100 : (lc.zone === "landmark" ? 86 : 52);
        if (lc.y <= GY && Math.hypot(x - lc.x, y - lc.y) < keep) near = true;
      }
      for (i = 0; i < avoidPts.length && !near; i++) {
        if (Math.hypot(x - avoidPts[i][0], y - avoidPts[i][1]) < 30) near = true;
      }
      if (near) continue;
      var variant = dd < 175 ? "dark" : (rand() < 0.16 ? "pine" : "round");
      if (pineLoc && Math.hypot(x - pineLoc.x, y - pineLoc.y) < 130) variant = "pine";
      placed.push({ x: x, y: y, s: 0.75 + rand() * 0.55, v: variant });
    }
  }
  placed.sort(function (a, b) { return a.y - b.y; });
  placed.forEach(function (t) { layerTrees.appendChild(tree(t.x, t.y, t.s, t.v)); });

  // ---------- storybook decor beneath the notable landmarks ----------
  function castle(x, y, s, glow) {
    var g = el("g");
    if (glow) g.appendChild(el("circle", { cx: x, cy: y, r: 52 * s, fill: "url(#fSun)", opacity: 0.55 }));
    var stone = "#b8b2a4", dark = "#8f8878", roof = "#a55b4b";
    g.appendChild(el("rect", { x: x - 26 * s, y: y - 10 * s, width: 52 * s, height: 34 * s, rx: 2, fill: stone, stroke: dark, "stroke-width": 1.6 }));
    [-1, 1].forEach(function (side) {
      var tx = x + side * 26 * s;
      g.appendChild(el("rect", { x: tx - 8 * s, y: y - 26 * s, width: 16 * s, height: 50 * s, rx: 2, fill: stone, stroke: dark, "stroke-width": 1.6 }));
      g.appendChild(el("path", { d: "M " + (tx - 10 * s) + "," + (y - 26 * s) + " L " + tx + "," + (y - 44 * s) + " L " + (tx + 10 * s) + "," + (y - 26 * s) + " Z", fill: roof, stroke: dark, "stroke-width": 1.4 }));
      g.appendChild(el("path", { d: "M " + tx + "," + (y - 44 * s) + " l 0," + (-8 * s) + " l " + 9 * s + "," + 2.5 * s + " l " + (-9 * s) + "," + 2.5 * s, fill: "#e0b64f", stroke: "none" }));
    });
    // Central keep + crenellations + door.
    g.appendChild(el("rect", { x: x - 9 * s, y: y - 24 * s, width: 18 * s, height: 16 * s, fill: stone, stroke: dark, "stroke-width": 1.4 }));
    for (var ci = -2; ci <= 2; ci++) g.appendChild(el("rect", { x: x + ci * 8 * s - 3 * s, y: y - 14 * s, width: 6 * s, height: 5 * s, fill: stone, stroke: dark, "stroke-width": 1 }));
    g.appendChild(el("path", { d: "M " + (x - 5 * s) + "," + (y + 24 * s) + " v " + (-10 * s) + " a " + 5 * s + " " + 5 * s + " 0 0 1 " + 10 * s + " 0 v " + 10 * s + " Z", fill: "#6d4a2e" }));
    return g;
  }
  function mountainDecor(x, y, s, muddy) {
    var g = el("g");
    var fill = muddy ? "#b08a5a" : "#c4bfae", edge = muddy ? "#8a6543" : "#96917f";
    g.appendChild(el("path", { d: "M " + (x - 52 * s) + "," + (y + 30 * s) + " Q " + (x - 20 * s) + "," + (y - 34 * s) + " " + x + "," + (y - 38 * s) + " Q " + (x + 24 * s) + "," + (y - 33 * s) + " " + (x + 52 * s) + "," + (y + 30 * s) + " Z", fill: fill, stroke: edge, "stroke-width": 2 }));
    if (muddy) {
      g.appendChild(el("ellipse", { cx: x - 12 * s, cy: y + 2 * s, rx: 7 * s, ry: 5 * s, fill: "#6d4a2e" }));
      g.appendChild(el("ellipse", { cx: x + 14 * s, cy: y + 12 * s, rx: 4 * s, ry: 3 * s, fill: "#6d4a2e" }));
    }
    return g;
  }
  function pineMountain(x, y, s) {
    var g = el("g");
    [[42, 26], [34, 6], [24, -13]].forEach(function (t) {
      g.appendChild(el("path", { d: "M " + (x - t[0] * s) + "," + (y + t[1] * s) + " L " + x + "," + (y + (t[1] - 34) * s) + " L " + (x + t[0] * s) + "," + (y + t[1] * s) + " Z", fill: "#48713f", stroke: "#3c5f35", "stroke-width": 1.6 }));
    });
    g.appendChild(el("circle", { cx: x + 10 * s, cy: y + 14 * s, r: 4 * s, fill: "#e58fb1", stroke: "#fdf6e3", "stroke-width": 1.4 }));
    return g;
  }
  function canyonDecor(x, y, s) {
    var g = el("g");
    [-1, 1].forEach(function (side) {
      var cx2 = x + side * 24 * s;
      g.appendChild(el("path", { d: "M " + (cx2 - 14 * s) + "," + (y + 26 * s) + " L " + (cx2 - 8 * s) + "," + (y - 22 * s) + " L " + (cx2 + 8 * s) + "," + (y - 20 * s) + " L " + (cx2 + 14 * s) + "," + (y + 26 * s) + " Z", fill: "#c9a778", stroke: "#8a6543", "stroke-width": 1.8 }));
    });
    g.appendChild(el("path", { d: "M " + (x - 4 * s) + "," + (y - 8 * s) + " C " + (x + 4 * s) + "," + (y + 4 * s) + " " + (x - 4 * s) + "," + (y + 16 * s) + " " + (x + 2 * s) + "," + (y + 26 * s), fill: "none", stroke: "#8fbdd6", "stroke-width": 3 * s, "stroke-linecap": "round" }));
    return g;
  }
  function boulder(x, y, s) {
    var g = el("g");
    g.appendChild(el("path", { d: blobPath(x, y + 6 * s, 30 * s, 20 * s, "big-rock", 0.16), fill: "#b3ac9a", stroke: "#8f8878", "stroke-width": 2 }));
    g.appendChild(el("path", { d: "M " + (x - 12 * s) + "," + (y - 2 * s) + " q " + 8 * s + "," + 6 * s + " " + 20 * s + "," + 4 * s, fill: "none", stroke: "#8f8878", "stroke-width": 1.4, opacity: 0.7 }));
    return g;
  }
  // Icicle's sparkly palace: pale-ice towers with pointed spires and a cold glow.
  function icePalace(x, y, s) {
    var g = el("g");
    g.appendChild(el("circle", { cx: x, cy: y - 6 * s, r: 54 * s, fill: "url(#fHalo-water)", opacity: 0.7 }));
    var ice = "#e2f1fb", edge = "#93c2df", deep = "#c3e2f4", door = "#7fa8c4";
    [-1, 1].forEach(function (side) {
      var tx = x + side * 23 * s;
      g.appendChild(el("rect", { x: tx - 8 * s, y: y - 22 * s, width: 16 * s, height: 46 * s, rx: 2, fill: ice, stroke: edge, "stroke-width": 1.6 }));
      g.appendChild(el("path", { d: "M " + (tx - 8 * s) + "," + (y - 22 * s) + " L " + tx + "," + (y - 48 * s) + " L " + (tx + 8 * s) + "," + (y - 22 * s) + " Z", fill: deep, stroke: edge, "stroke-width": 1.4 }));
    });
    g.appendChild(el("rect", { x: x - 12 * s, y: y - 10 * s, width: 24 * s, height: 34 * s, rx: 2, fill: ice, stroke: edge, "stroke-width": 1.6 }));
    g.appendChild(el("path", { d: "M " + (x - 12 * s) + "," + (y - 10 * s) + " L " + x + "," + (y - 40 * s) + " L " + (x + 12 * s) + "," + (y - 10 * s) + " Z", fill: deep, stroke: edge, "stroke-width": 1.4 }));
    g.appendChild(el("path", { d: "M " + (x - 5 * s) + "," + (y + 24 * s) + " v " + (-11 * s) + " a " + 5 * s + " " + 5 * s + " 0 0 1 " + 10 * s + " 0 v " + 11 * s + " Z", fill: door }));
    [[-32, -30], [30, -36], [37, 6], [-36, 8]].forEach(function (p) {
      var sx = x + p[0] * s, sy = y + p[1] * s, a = 3.6 * s, b = 1.1 * s;
      g.appendChild(el("path", { d: "M " + sx + "," + (sy - a) + " L " + (sx + b) + "," + (sy - b) + " L " + (sx + a) + "," + sy + " L " + (sx + b) + "," + (sy + b) + " L " + sx + "," + (sy + a) + " L " + (sx - b) + "," + (sy + b) + " L " + (sx - a) + "," + sy + " L " + (sx - b) + "," + (sy - b) + " Z", fill: "#ffffff" }));
    });
    return g;
  }
  var DECOR = {
    "icicles-ice-palace": function (l) { return icePalace(l.x, l.y - 6, 0.92); },
    "peacocks-castle": function (l) { return castle(l.x, l.y - 6, 1.05, false); },
    "seekers-castle": function (l) { return castle(l.x, l.y - 6, 0.9, true); },
    "the-mountain": function (l) { return mountainDecor(l.x, l.y - 4, 1.1, true); },
    "christmas-tree-mountain": function (l) { return pineMountain(l.x, l.y - 2, 1); },
    "the-canyon": function (l) { return canyonDecor(l.x, l.y - 2, 0.9); },
    "the-big-rock": function (l) { return boulder(l.x, l.y, 1); },
    "beehive": function (l) {
      var g = el("g");
      g.appendChild(el("path", { d: blobPath(l.x, l.y + 14, 34, 22, "hive-bush", 0.22), fill: "#6f9a55", stroke: "#5f8a48", "stroke-width": 1.4 }));
      var br = prng("hive-flowers");
      for (var i = 0; i < 7; i++) g.appendChild(el("circle", { cx: l.x - 30 + br() * 60, cy: l.y + 4 + br() * 22, r: 2.6, fill: "#e58fb1" }));
      return g;
    },
    "the-pond": function (l) {
      var g = el("g");
      g.appendChild(el("rect", { x: l.x - 74, y: l.y - 12, width: 34, height: 11, rx: 2, fill: "#b08a5a", stroke: "#8a6543", "stroke-width": 1.4, transform: "rotate(-8 " + (l.x - 60) + " " + l.y + ")" }));
      [0, 1, 2].forEach(function (i) {
        g.appendChild(el("rect", { x: l.x - 70 + i * 11, y: l.y - 3, width: 2.6, height: 9, fill: "#8a6543", transform: "rotate(-8 " + (l.x - 60) + " " + l.y + ")" }));
      });
      return g;
    },
    "the-swamp": function (l) {
      var g = el("g");
      var br = prng("reeds");
      for (var i = 0; i < 10; i++) {
        var rx4 = l.x - 62 + br() * 124, ry4 = l.y - 30 + br() * 62, rh = 12 + br() * 12;
        g.appendChild(el("path", { d: "M " + rx4 + "," + ry4 + " q 1,-" + rh + " 3,-" + (rh + 3), fill: "none", stroke: "#5d7a3e", "stroke-width": 2, "stroke-linecap": "round" }));
        if (br() < 0.5) g.appendChild(el("ellipse", { cx: rx4 + 3.4, cy: ry4 - rh - 4, rx: 2, ry: 5, fill: "#8a6543" }));
      }
      return g;
    }
  };
  locations.forEach(function (loc) {
    if (DECOR[loc.id]) layerDecor.appendChild(DECOR[loc.id](loc));
  });

  // ---------- the soil cutaway ----------
  var groundD = "M -80," + GY;
  for (var wx = -80; wx <= CW + 80; wx += 60) {
    groundD += " q 30,-9 60,0";
  }
  layerSoil.appendChild(el("path", { d: groundD + " L " + (CW + 80) + "," + (CH + 80) + " L -80," + (CH + 80) + " Z", fill: "url(#fSoil)" }));
  layerSoil.appendChild(el("path", { d: groundD, fill: "none", stroke: "#5d7a3e", "stroke-width": 7, "stroke-linecap": "round" }));
  // Grass tufts and small flowers along the ground line.
  var grand = prng("grass");
  for (var tx = -40; tx < CW + 40; tx += 26) {
    var gx2 = tx + grand() * 14, gh = 7 + grand() * 8;
    layerSoil.appendChild(el("path", { d: "M " + gx2 + "," + (GY - 2) + " q 2,-" + gh + " 5,-" + (gh + 3) + " M " + (gx2 + 4) + "," + (GY - 2) + " q 1,-" + (gh - 2) + " -2,-" + (gh + 1), fill: "none", stroke: "#5d7a3e", "stroke-width": 1.8, "stroke-linecap": "round" }));
    if (grand() < 0.18) layerSoil.appendChild(el("circle", { cx: gx2 + 2, cy: GY - gh - 8, r: 2.6, fill: ["#e58fb1", "#f2c469", "#c8a2d8"][Math.floor(grand() * 3)] }));
  }
  // Soil strata + buried pebbles.
  layerSoil.appendChild(el("path", { d: "M -80," + (GY + 130) + " C 240," + (GY + 108) + " 620," + (GY + 156) + " 1080," + (GY + 122), fill: "none", stroke: "#6d4a2e", "stroke-width": 2.5, opacity: 0.5 }));
  layerSoil.appendChild(el("path", { d: "M -80," + (GY + 270) + " C 300," + (GY + 296) + " 700," + (GY + 244) + " 1080," + (GY + 282), fill: "none", stroke: "#5a3c25", "stroke-width": 2.5, opacity: 0.5 }));
  var rrand = prng("rocks");
  for (var ri = 0; ri < 34; ri++) {
    var rx2 = rrand() * CW, ry2 = GY + 40 + rrand() * (CH - GY - 80);
    layerSoil.appendChild(el("ellipse", { cx: rx2, cy: ry2, rx: 5 + rrand() * 9, ry: 4 + rrand() * 6, fill: "#7a5636", opacity: 0.55, transform: "rotate(" + (rrand() * 40 - 20) + " " + rx2 + " " + ry2 + ")" }));
  }
  // Roots reaching down from the treeline into the soil band.
  [[520, "roots-lib"], [180, "roots-a"], [820, "roots-b"]].forEach(function (r) {
    var rx3 = r[0];
    layerSoil.appendChild(el("path", {
      d: "M " + (rx3 - 26) + "," + (GY - 4) + " C " + (rx3 - 34) + "," + (GY + 40) + " " + (rx3 - 60) + "," + (GY + 60) + " " + (rx3 - 66) + "," + (GY + 96) +
         " M " + rx3 + "," + (GY - 4) + " C " + (rx3 - 4) + "," + (GY + 50) + " " + (rx3 + 8) + "," + (GY + 74) + " " + (rx3 + 2) + "," + (GY + 112) +
         " M " + (rx3 + 24) + "," + (GY - 4) + " C " + (rx3 + 34) + "," + (GY + 36) + " " + (rx3 + 52) + "," + (GY + 58) + " " + (rx3 + 62) + "," + (GY + 90),
      fill: "none", stroke: "#6d4a2e", "stroke-width": 5, "stroke-linecap": "round", opacity: 0.8
    }));
  });
  // The old stump above the Underground Library.
  var lib = locById("underground-library");
  if (lib) {
    var sx = lib.x;
    layerSoil.appendChild(el("path", { d: "M " + (sx - 22) + "," + (GY - 2) + " L " + (sx - 17) + "," + (GY - 34) + " Q " + sx + "," + (GY - 42) + " " + (sx + 17) + "," + (GY - 34) + " L " + (sx + 22) + "," + (GY - 2) + " Z", fill: "#8a6543", stroke: "#6d4a2e", "stroke-width": 2 }));
    layerSoil.appendChild(el("ellipse", { cx: sx, cy: GY - 36, rx: 17, ry: 6, fill: "#c9a778", stroke: "#6d4a2e", "stroke-width": 2 }));
    layerSoil.appendChild(el("ellipse", { cx: sx, cy: GY - 36, rx: 9, ry: 3, fill: "none", stroke: "#a5805a", "stroke-width": 1.4 }));
  }

  // ---------- tunnels + burrow chambers ----------
  paths.forEach(function (p) {
    if (p.kind !== "tunnel") return;
    var els = [
      el("path", { d: p.d, fill: "none", stroke: "#573a24", "stroke-width": 27, "stroke-linecap": "round", opacity: 0.85 }),
      el("path", { d: p.d, fill: "none", stroke: "#c49a6c", "stroke-width": 21, "stroke-linecap": "round" }),
      el("path", { d: p.d, fill: "none", stroke: "#8a5f3c", "stroke-width": 1.6, "stroke-dasharray": "5 9", opacity: 0.7 })
    ];
    els.forEach(function (e) { layerTunnels.appendChild(e); });
    var ref = el("path", { id: "fp-" + p.id, d: p.d, fill: "none", stroke: "none" });
    layerTunnels.appendChild(ref);
    pathEls.push({ els: els, zone: "underground", ref: ref, p: p });
  });
  locations.forEach(function (loc) {
    if (loc.zone !== "underground") return;
    var r = radiusOf(loc);
    if (loc.id === "discos-basket-house") {
      layerTunnels.appendChild(el("circle", { cx: loc.x, cy: loc.y, r: r + 46, fill: "url(#fBasketGlow)" }));
    }
    layerTunnels.appendChild(el("ellipse", { cx: loc.x, cy: loc.y, rx: r + 26, ry: r + 17, fill: "#c49a6c", stroke: "#573a24", "stroke-width": 3 }));
    layerTunnels.appendChild(el("ellipse", { cx: loc.x, cy: loc.y + 4, rx: r + 18, ry: r + 10, fill: "#d4ad7f", opacity: 0.7 }));
    if (loc.id === "underground-library") {
      // Tiny book spines on an earthen shelf.
      var brand = prng("books");
      for (var bi = 0; bi < 7; bi++) {
        var bx = loc.x - 42 + bi * 12 + brand() * 3, bh = 12 + brand() * 7;
        layerTunnels.appendChild(el("rect", { x: bx, y: loc.y + r + 22 - bh, width: 8, height: bh, rx: 1.5, fill: ["#a55b4b", "#4f7a43", "#4f89ab", "#c98d3f", "#8a5f8e"][bi % 5], opacity: 0.95 }));
      }
      layerTunnels.appendChild(el("path", { d: "M " + (loc.x - 50) + "," + (loc.y + r + 24) + " L " + (loc.x + 50) + "," + (loc.y + r + 24), stroke: "#573a24", "stroke-width": 4, "stroke-linecap": "round" }));
    }
  });

  // ---------- markers ----------
  // Small vector glyphs (24x24 space, drawn at marker center when no image).
  var GLYPH = {
    canopy: "M12 3 C 7 8 5 13 12 21 C 19 13 17 8 12 3 M12 8 L 12 18",
    surface: "M4 12 L 12 4 L 20 12 M6.5 10.5 V 19 H 17.5 V 10.5",
    water: "M12 3 C 8 9 5.5 12 5.5 15.5 A 6.5 6.5 0 0 0 18.5 15.5 C 18.5 12 16 9 12 3",
    landmark: "M5 20 V 8 H 8 V 5 H 10 V 8 H 14 V 5 H 16 V 8 H 19 V 20 M 9.5 20 V 14 H 14.5 V 20",
    underground: "M4 19 A 8 8 0 0 1 20 19 M 8.5 19 A 3.5 3.5 0 0 1 15.5 19"
  };
  var locEls = {}, selId = null, didPan = false;
  locations.forEach(function (loc) {
    var r = radiusOf(loc), zc = ZONE[loc.zone] || ZONE.surface;
    var g = el("g", { class: "loc", tabindex: "0", role: "button" });
    g.setAttribute("aria-label", loc.name);
    g.dataset.id = loc.id; g.dataset.zone = loc.zone;
    if (loc.size !== "major") g.classList.add("small-lbl");

    g.appendChild(el("circle", { class: "halo", cx: loc.x, cy: loc.y, r: r * 2.1, fill: "url(#fHalo-" + loc.zone + ")" }));

    var face = resolveImage(loc, "art") || resolveImage(loc, "vignette");
    if (face) {
      var patId = "fPat-" + loc.id;
      var pat = el("pattern", { id: patId, width: 1, height: 1, patternContentUnits: "objectBoundingBox" });
      var im = el("image", { x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: "xMidYMid slice" });
      im.setAttributeNS("http://www.w3.org/1999/xlink", "href", face);
      im.setAttribute("href", face);
      pat.appendChild(im); defs.appendChild(pat);
      g.appendChild(el("circle", { class: "disc-bg", cx: loc.x, cy: loc.y, r: r, fill: "url(#" + patId + ")" }));
    } else {
      g.appendChild(el("circle", { class: "disc-bg", cx: loc.x, cy: loc.y, r: r, fill: zc.raw }));
      var gs = (r * 2 * 0.62) / 24; // glyph scale into the disc
      var gl = el("path", { d: GLYPH[loc.zone] || GLYPH.surface, fill: "none", stroke: "#fdf6e3", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" });
      gl.setAttribute("transform", "translate(" + (loc.x - 12 * gs) + " " + (loc.y - 12 * gs) + ") scale(" + gs + ")");
      g.appendChild(gl);
    }
    // Sticker rims: parchment inner, zone-colored outer.
    g.appendChild(el("circle", { class: "rim-in", cx: loc.x, cy: loc.y, r: r, fill: "none", stroke: "#fdf6e3", "stroke-width": 3.4 }));
    g.appendChild(el("circle", { class: "rim", cx: loc.x, cy: loc.y, r: r + 2.4, fill: "none", stroke: zc.raw, "stroke-width": 1.8 }));

    var count = (loc.stories || []).length;
    if (count >= 3) {
      var bx = loc.x + r * 0.74, by = loc.y - r * 0.74;
      g.appendChild(el("circle", { cx: bx, cy: by, r: 9.5, fill: zc.raw, stroke: "#fdf6e3", "stroke-width": 2 }));
      var bt = el("text", { x: bx, y: by, class: "badge-count" }); bt.textContent = count; g.appendChild(bt);
    }

    var above = loc.zone === "canopy";
    var lblY = above ? loc.y - r - 10 : loc.y + r + 17;
    var t = el("text", { class: "label", x: loc.x, y: lblY, "text-anchor": "middle", "font-size": loc.size === "major" ? 15.5 : 12 });
    t.textContent = loc.name;
    g.appendChild(t);

    layerMarkers.appendChild(g);
    locEls[loc.id] = g;

    g.addEventListener("click", function () { if (!didPan) openCodex(loc.id); });
    g.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openCodex(loc.id); } });
  });

  // Labels that ride along the linear features.
  paths.forEach(function (p) {
    if (!p.label) return;
    var t = el("text", { class: "path-label", dy: p.kind === "tunnel" ? -18 : -8 });
    var tp = el("textPath", { startOffset: p.labelOffset || "38%" });
    tp.setAttributeNS("http://www.w3.org/1999/xlink", "href", "#fp-" + p.id);
    tp.setAttribute("href", "#fp-" + p.id);
    tp.textContent = p.label;
    t.appendChild(tp);
    layerLabels.appendChild(t);
  });

  // ---------- legend + filter ----------
  var counts = {};
  locations.forEach(function (l) { counts[l.zone] = (counts[l.zone] || 0) + 1; });
  var activeFilter = null;
  ZONE_ORDER.forEach(function (z) {
    var li = document.createElement("li");
    li.dataset.zone = z;
    li.innerHTML = '<span class="dot" style="background:' + ZONE[z].raw + ';color:' + ZONE[z].raw + '"></span><span>' + ZONE[z].label + '</span><span class="n">' + (counts[z] || 0) + '</span>';
    li.addEventListener("click", function () { toggleFilter(z); });
    legendList.appendChild(li);
  });
  function toggleFilter(z) {
    activeFilter = (activeFilter === z) ? null : z;
    svg.classList.toggle("filtered", !!activeFilter);
    locations.forEach(function (l) {
      locEls[l.id].classList.toggle("off", !!activeFilter && l.zone !== activeFilter);
    });
    pathEls.forEach(function (pe) {
      pe.els.forEach(function (e) { e.classList.toggle("off", !!activeFilter && pe.zone !== activeFilter); });
    });
    Array.prototype.forEach.call(legendList.children, function (li) {
      li.classList.toggle("dim", !!activeFilter && li.dataset.zone !== z);
    });
  }

  // ---------- codex ----------
  function openCodex(id) {
    var loc = locById(id);
    if (!loc) return;
    if (selId && locEls[selId]) locEls[selId].classList.remove("sel");
    selId = id; locEls[id].classList.add("sel");
    var zc = ZONE[loc.zone] || ZONE.surface;
    var hero = resolveImage(loc, "art") || resolveImage(loc, "image");
    var h = "";
    h += '<button class="cx-close" type="button" aria-label="Close">×</button>';
    h += '<div class="cx-hero">' + (hero ? '<img src="' + hero + '" alt="' + esc(loc.name) + '">' : '<div class="noimg">No illustration yet</div>') + '</div>';
    h += '<div class="cx-body">';
    h += '<span class="cx-cat" style="color:' + zc.raw + '"><span class="dot" style="background:' + zc.raw + '"></span>' + esc(zc.label) + '</span>';
    h += '<h2>' + esc(loc.name) + '</h2>';
    var count = (loc.stories || []).length;
    h += '<div class="cx-meta"><span><b>' + count + '</b> ' + (count === 1 ? "story" : "stories") + '</span>';
    var earliest = (loc.stories || []).map(function (s) { return s.date; }).sort()[0];
    if (earliest) h += '<span>first visited <b>' + esc(fmtDate(earliest)) + '</b></span>';
    h += '</div>';
    h += '<p class="cx-desc">' + esc(loc.curatedDescription) + '</p>';
    if (loc.quotes && loc.quotes.length) {
      h += '<span class="cx-section-label">From the tapes</span><div class="qwrap">';
      loc.quotes.forEach(function (q) {
        var qt = String(q.text || "").replace(/^["“](.*)["”]$/s, "$1").trim();
        h += '<blockquote class="pullquote"><span class="q">“' + esc(qt) + '”</span><span class="attr">— <b>' + esc(q.speaker) + '</b></span></blockquote>';
      });
      h += '</div>';
    }
    if (loc.characters && loc.characters.length) {
      h += '<span class="cx-section-label">Who lives here</span><div class="chips">';
      loc.characters.forEach(function (c) { h += '<span class="chip">' + esc(c) + '</span>'; });
      h += '</div>';
    }
    if (loc.stories && loc.stories.length) {
      h += '<span class="cx-section-label">' + (loc.stories.length === 1 ? "The story" : "The stories") + '</span><ul class="stories">';
      loc.stories.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).forEach(function (s) {
        h += '<li><span class="st-title">' + esc(s.title) + '</span><span class="st-date">' + esc(fmtDate(s.date)) + '</span></li>';
      });
      h += '</ul>';
    }
    h += '</div>';
    codex.innerHTML = h;
    codex.hidden = false; scrim.hidden = false; codex.setAttribute("aria-hidden", "false");
    requestAnimationFrame(function () { codex.classList.add("show"); scrim.classList.add("show"); });
    codex.scrollTop = 0;
    codex.querySelector(".cx-close").addEventListener("click", closeCodex);
    if (hint) hint.style.opacity = "0";
  }
  function closeCodex() {
    codex.classList.remove("show"); scrim.classList.remove("show"); codex.setAttribute("aria-hidden", "true");
    if (selId && locEls[selId]) locEls[selId].classList.remove("sel");
    selId = null;
    setTimeout(function () { codex.hidden = true; scrim.hidden = true; }, 420);
  }
  scrim.addEventListener("click", closeCodex);

  // ---------- zoom + pan (viewBox camera) ----------
  var baseView = { x: -30, y: -30, w: CW + 60, h: CH + 60 };
  var cam = { x: baseView.x, y: baseView.y, w: baseView.w, h: baseView.h };
  var MINW = 300;
  function applyCam() { svg.setAttribute("viewBox", cam.x + " " + cam.y + " " + cam.w + " " + cam.h); }
  function clampPan() {
    var M = 140;
    cam.x = Math.max(baseView.x - M, Math.min(cam.x, baseView.x + baseView.w - cam.w + M));
    cam.y = Math.max(baseView.y - M, Math.min(cam.y, baseView.y + baseView.h - cam.h + M));
  }
  applyCam();
  function onWheel(e) {
    e.preventDefault();
    var rect = svg.getBoundingClientRect();
    var px = (e.clientX - rect.left) / rect.width, py = (e.clientY - rect.top) / rect.height;
    var vx = cam.x + px * cam.w, vy = cam.y + py * cam.h;
    var factor = Math.exp(e.deltaY * 0.0016);
    var newW = Math.max(MINW, Math.min(cam.w * factor, baseView.w));
    var ratio = baseView.h / baseView.w;
    cam.x = vx - px * newW; cam.y = vy - py * newW * ratio; cam.w = newW; cam.h = newW * ratio;
    clampPan(); applyCam();
  }
  svg.addEventListener("wheel", onWheel, { passive: false });

  var dragging = false, sx = 0, sy = 0, sCam = null;
  function onDown(e) {
    if (e.button != null && e.button !== 0) return;
    dragging = true; didPan = false; sx = e.clientX; sy = e.clientY; sCam = { x: cam.x, y: cam.y };
    svg.classList.add("grabbing");
  }
  function onMove(e) {
    if (!dragging) return;
    var rect = svg.getBoundingClientRect();
    var dx = (e.clientX - sx) / rect.width * cam.w, dy = (e.clientY - sy) / rect.height * cam.h;
    if (!didPan && Math.hypot(e.clientX - sx, e.clientY - sy) > 4) didPan = true;
    if (didPan) { cam.x = sCam.x - dx; cam.y = sCam.y - dy; clampPan(); applyCam(); }
  }
  function onUp() { dragging = false; svg.classList.remove("grabbing"); setTimeout(function () { didPan = false; }, 30); }
  svg.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  function resetZoom() { cam = { x: baseView.x, y: baseView.y, w: baseView.w, h: baseView.h }; applyCam(); }
  svg.addEventListener("dblclick", resetZoom);

  function onKey(e) {
    if (e.key === "Escape") { if (!codex.hidden) closeCodex(); }
    else if (e.key === "0") resetZoom();
  }
  document.addEventListener("keydown", onKey);

  // ---------- cleanup ----------
  return function cleanup() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.removeEventListener("keydown", onKey);
    root.innerHTML = ""; root.classList.remove("forest-map");
  };
}
