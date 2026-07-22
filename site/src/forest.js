/* ================= The Stars & Stories Forest — map engine =================
   Framework-agnostic. mountForest(root, data, resolveImage, landscapeUrl) builds
   the interactive storybook map inside `root` and returns a cleanup function.
     - data: the forest.json document ({ meta, locations, paths }).
     - resolveImage(loc, field) -> image URL or null, field in
       "art" | "image" | "vignette" (site: assetUrl(loc[field])).
     - landscapeUrl: the Tolkien-style landscape backdrop (a raster). The map
       is that painting with clickable SVG markers + labels overlaid on top.
   The landscape is a 3:4 image stretched to fill the 5:7 data canvas
   (preserveAspectRatio="none"), which inverts the squash the sketch went
   through at generation time, so markers land exactly where the sketch put them.
   (The procedural-terrain renderer this replaced lives in forest-legacy.js.) */

export function mountForest(root, data, resolveImage, landscapeUrl) {
  var SVGNS = "http://www.w3.org/2000/svg";
  var XLINK = "http://www.w3.org/1999/xlink";
  resolveImage = resolveImage || function () { return null; };

  var ZONE = {
    canopy:      { raw: "#4f7a43", label: "Treetops & Nests" },
    surface:     { raw: "#6c9147", label: "Forest Floor" },
    water:       { raw: "#4f89ab", label: "Ponds & Streams" },
    landmark:    { raw: "#a8783f", label: "Hills & Castles" },
    underground: { raw: "#8a5f3c", label: "Down in the Burrows" }
  };
  var ZONE_ORDER = ["canopy", "surface", "water", "landmark", "underground"];
  // Which legend zone dims/undims each linear feature's label when filtering.
  var KIND_ZONE = { road: "surface", trail: "surface", river: "water", stream: "water", tunnel: "underground" };

  var meta = data.meta || {};
  var canvas = meta.canvas || { width: 1000, height: 1400, groundY: 1000 };
  var CW = canvas.width, CH = canvas.height;
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
  // Soft zone-colored halos behind markers (the only gradients we still need).
  ZONE_ORDER.forEach(function (z) {
    var g = el("radialGradient", { id: "fHalo-" + z });
    [["0%", 0.5], ["60%", 0.18], ["100%", 0]].forEach(function (s) {
      g.appendChild(el("stop", { offset: s[0], "stop-color": ZONE[z].raw, "stop-opacity": s[1] }));
    });
    defs.appendChild(g);
  });

  // ---------- layers ----------
  var layerImage = el("g"), layerPaths = el("g"), layerMarkers = el("g"), layerLabels = el("g");
  [layerImage, layerPaths, layerMarkers, layerLabels].forEach(function (g) { svg.appendChild(g); });

  function locById(id) { return locations.find(function (l) { return l.id === id; }); }
  function radiusOf(loc) { return loc.size === "major" ? 26 : 16; }

  // ---------- base layer: the painted landscape ----------
  // Stretched to fill the data canvas exactly; markers use the same coordinates.
  if (landscapeUrl) {
    var img = el("image", { x: 0, y: 0, width: CW, height: CH, preserveAspectRatio: "none" });
    img.setAttributeNS(XLINK, "href", landscapeUrl);
    img.setAttribute("href", landscapeUrl);
    layerImage.appendChild(img);
  } else {
    layerImage.appendChild(el("rect", { x: 0, y: 0, width: CW, height: CH, fill: "#efe6cd" }));
  }

  // ---------- invisible path references (for labels that ride the curves) ----------
  paths.forEach(function (p) {
    layerPaths.appendChild(el("path", { id: "fp-" + p.id, d: p.d, fill: "none", stroke: "none" }));
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
      im.setAttributeNS(XLINK, "href", face);
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

  // Labels that ride along the linear features (river, road, the mole train line).
  var pathEls = []; // for filtering: {el, zone}
  paths.forEach(function (p) {
    if (!p.label) return;
    var t = el("text", { class: "path-label", dy: p.kind === "tunnel" ? -18 : -8 });
    var tp = el("textPath", { startOffset: p.labelOffset || "38%" });
    tp.setAttributeNS(XLINK, "href", "#fp-" + p.id);
    tp.setAttribute("href", "#fp-" + p.id);
    tp.textContent = p.label;
    t.appendChild(tp);
    layerLabels.appendChild(t);
    pathEls.push({ el: t, zone: KIND_ZONE[p.kind] || "surface" });
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
      pe.el.classList.toggle("off", !!activeFilter && pe.zone !== activeFilter);
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
        var row = '<span class="st-title">' + esc(s.title) + '</span><span class="st-date">' + esc(fmtDate(s.date)) + '</span>';
        h += '<li>' + (s.slug
          ? '<a class="st-link" href="#/story/' + encodeURIComponent(s.slug) + '">' + row + '</a>'
          : '<span class="st-link">' + row + '</span>') + '</li>';
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
