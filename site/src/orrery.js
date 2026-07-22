/* ================= The Stars & Stories Cosmos — orrery engine =================
   Framework-agnostic. mountOrrery(root, data, resolveImage) builds the whole
   interactive map inside `root` and returns a cleanup function.
     - data: the worlds.json document ({ meta, worlds }).
     - resolveImage(world) -> image URL or null (artifact: base64 data URI;
       site: assetUrl(world.image)).
   The artifact inlines this file (with `export ` stripped); the site imports it. */

export function mountOrrery(root, data, resolveImage) {
  var SVGNS = "http://www.w3.org/2000/svg";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  resolveImage = resolveImage || function () { return null; };

  var CAT = {
    "home-base":      { raw: "#ebb661", label: "Home & Hub" },
    "earthly":        { raw: "#93bd8c", label: "Earthly Realms" },
    "elemental-plane":{ raw: "#dd8a58", label: "Elemental Planes" },
    "alien-planet":   { raw: "#82abd8", label: "Cosmic & Alien Worlds" },
    "whimsical-world":{ raw: "#cd8cc6", label: "Whimsical Worlds" }
  };
  var CAT_ORDER = ["home-base", "earthly", "elemental-plane", "alien-planet", "whimsical-world"];
  var RING_R = { 1: 146, 2: 236, 3: 312, 4: 384, 5: 452 };
  var RING_CAT = { 1: "home-base", 2: "earthly", 3: "elemental-plane", 4: "alien-planet", 5: "whimsical-world" };
  var RING_OFFSET = { 1: -90, 2: -66, 3: -102, 4: -78, 5: -90 };
  var CX = 500, CY = 500;
  var SHORT = {
    "seekers-castle": "Seeker’s Castle",
    "cornell-street": "Cornell Street",
    "coral-reef-gemstone": "Gemstone Reef",
    "rainbow-planet": "Rainbow Planet",
    "sea-mice-kingdom": "Sea Mice Kingdom",
    "ant-kingdom": "Ant Kingdom"
  };

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
  function rot(x, y, deg) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    var dx = x - CX, dy = y - CY;
    return { x: CX + dx * c - dy * s, y: CY + dx * s + dy * c };
  }

  // ---------- shell ----------
  root.classList.add("cosmos");
  var meta = data.meta || {};
  root.innerHTML =
    '<canvas class="stars"></canvas>' +
    '<div class="stage"></div>' +
    '<header class="masthead">' +
      '<p class="eyebrow">A Celestial Atlas</p>' +
      '<h1>' + esc(meta.title || "The Stars & Stories Cosmos") + '</h1>' +
      '<p class="sub">' + esc(meta.subtitle || "") + '</p>' +
    '</header>' +
    '<aside class="legend" aria-label="Legend"><h2>The Rings</h2><ul class="legend-list"></ul></aside>' +
    '<div class="hint">Scroll to zoom · drag to pan · tap a world ✦</div>' +
    '<p class="credit">Every voyage folds back into pajamas and blankets.</p>' +
    '<div class="scrim" hidden></div>' +
    '<aside class="codex" aria-label="World codex" hidden aria-hidden="true"></aside>' +
    '<section class="intro"><div class="card">' +
      '<p class="eyebrow">Stars &amp; Stories</p>' +
      '<h1>A Map of the Multiverse</h1>' +
      '<p class="law">“' + esc(meta.law || "") + '”</p>' +
      '<p class="note">' + esc(meta.note || "") + '</p>' +
      '<button type="button">Enter the cosmos</button>' +
    '</div></section>';

  var stage = root.querySelector(".stage");
  var canvas = root.querySelector(".stars");
  var codex = root.querySelector(".codex");
  var scrim = root.querySelector(".scrim");
  var hint = root.querySelector(".hint");
  var legendList = root.querySelector(".legend-list");
  var intro = root.querySelector(".intro");

  var svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "orrery");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  stage.appendChild(svg);
  function el(name, attrs) {
    var e = document.createElementNS(SVGNS, name);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  var defs = el("defs"); svg.appendChild(defs);
  function addRadial(id, stops) {
    var g = el("radialGradient", { id: id });
    stops.forEach(function (s) { g.appendChild(el("stop", { offset: s[0], "stop-color": s[1], "stop-opacity": s[2] })); });
    defs.appendChild(g);
  }

  // ---------- layout ----------
  var worlds = data.worlds.slice();
  var home = null, hub = null;
  var byRing = {};
  worlds.forEach(function (w) {
    if (w.role === "home") { home = w; return; }
    if (w.role === "hub") hub = w;
    (byRing[w.ring] = byRing[w.ring] || []).push(w);
  });
  Object.keys(byRing).forEach(function (ring) {
    var arr = byRing[ring];
    arr.sort(function (a, b) { return String(a.earliestDate).localeCompare(String(b.earliestDate)); });
    var off = (RING_OFFSET[ring] || -90) * Math.PI / 180;
    arr.forEach(function (w, i) {
      var ang = off + (i / arr.length) * Math.PI * 2, R = RING_R[ring];
      w._x = CX + R * Math.cos(ang); w._y = CY + R * Math.sin(ang);
    });
  });
  if (home) { home._x = CX; home._y = CY; }
  function radiusOf(w) {
    if (w.role === "home") return 48;
    if (w.role === "hub") return 38;
    return 16 + Math.pow(w.prominence || 0, 0.85) * 24;
  }

  // ---------- layers ----------
  var layerRoutes = el("g"), layerOrbits = el("g"), layerPlanets = el("g");
  svg.appendChild(layerRoutes); svg.appendChild(layerOrbits); svg.appendChild(layerPlanets);

  [1, 2, 3, 4, 5].forEach(function (r) {
    layerOrbits.appendChild(el("circle", { class: "orbit", cx: CX, cy: CY, r: RING_R[r], stroke: CAT[RING_CAT[r]].raw }));
  });
  addRadial("cosmoHomeGlow", [["0%", "#fff3d6", 0.95], ["30%", "#ebb661", 0.55], ["100%", "#ebb661", 0]]);
  var homeGlow = el("circle", { class: "home-glow", cx: CX, cy: CY, r: 120, fill: "url(#cosmoHomeGlow)" });
  layerOrbits.insertBefore(homeGlow, layerOrbits.firstChild);

  // ring rotation groups (for the hover-orbit effect)
  var ringGroups = {};
  [1, 2, 3, 4, 5].forEach(function (r) { var g = el("g"); g.setAttribute("class", "ring-rot"); ringGroups[r] = g; layerPlanets.appendChild(g); });
  var homeGroup = el("g"); layerPlanets.appendChild(homeGroup);

  var routeEls = {}, planetEls = {}, labelEls = {};
  var routeInfo = []; // {line, world, tx, ty} base target coords

  worlds.forEach(function (w) {
    if (w.role === "home") return;
    var ln = el("line", { class: "route", stroke: CAT[w.category].raw, x1: CX, y1: CY, x2: w._x, y2: w._y });
    layerRoutes.appendChild(ln);
    routeEls[w.id] = ln;
    routeInfo.push({ line: ln, world: w, tx: w._x, ty: w._y });
  });

  worlds.forEach(function (w, idx) {
    var r = radiusOf(w), cc = CAT[w.category];
    var g = el("g", { class: "planet", tabindex: "0", role: "button" });
    g.setAttribute("aria-label", w.name);
    g.dataset.id = w.id; g.dataset.cat = w.category;
    if (w.role === "world" && w.ring >= 3) g.classList.add("small-lbl");

    var haloId = "cosmoHalo-" + w.id;
    addRadial(haloId, [["0%", cc.raw, 0.6], ["55%", cc.raw, 0.22], ["100%", cc.raw, 0]]);
    g.appendChild(el("circle", { class: "halo", cx: w._x, cy: w._y, r: r * 2.3, fill: "url(#" + haloId + ")" }));

    var imgUri = resolveImage(w);
    if (imgUri) {
      var patId = "cosmoPat-" + w.id;
      var pat = el("pattern", { id: patId, width: 1, height: 1, patternContentUnits: "objectBoundingBox" });
      var im = el("image", { x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: "xMidYMid slice" });
      im.setAttributeNS("http://www.w3.org/1999/xlink", "href", imgUri);
      im.setAttribute("href", imgUri);
      pat.appendChild(im); defs.appendChild(pat);
      g.appendChild(el("circle", { class: "disc-bg", cx: w._x, cy: w._y, r: r, fill: "url(#" + patId + ")" }));
    } else {
      var gid = "cosmoDisc-" + w.id;
      addRadial(gid, [["0%", "#26304f", 1], ["100%", "#0e1326", 1]]);
      g.appendChild(el("circle", { class: "disc-bg", cx: w._x, cy: w._y, r: r, fill: "url(#" + gid + ")" }));
      var em = el("text", { x: w._x, y: w._y + r * 0.32, class: "badge-count", "font-size": Math.max(12, r * 0.9) });
      em.textContent = "✦"; em.setAttribute("fill", cc.raw); g.appendChild(em);
    }
    g.appendChild(el("circle", { class: "rim", cx: w._x, cy: w._y, r: r, stroke: cc.raw }));

    if (w.storyCount >= 2 && w.role === "world") {
      var bx = w._x + r * 0.72, by = w._y - r * 0.72;
      g.appendChild(el("circle", { cx: bx, cy: by, r: 9, fill: cc.raw, stroke: "#05060d", "stroke-width": 1.5 }));
      var bt = el("text", { x: bx, y: by, class: "badge-count" }); bt.textContent = w.storyCount; g.appendChild(bt);
    }

    var isHome = w.role !== "world";
    var lblY = w._y + r + (isHome ? 20 : 15);
    var fs = isHome ? 16 : Math.max(10.5, Math.min(15, r * 0.55));
    var t = el("text", { class: "label", x: w._x, y: lblY, "text-anchor": "middle", "font-size": fs });
    t.textContent = SHORT[w.id] || w.name;
    g.appendChild(t);
    labelEls[w.id] = { el: t, x: w._x, y: lblY, ring: w.ring, role: w.role };

    (w.role === "home" ? homeGroup : ringGroups[w.ring]).appendChild(g);
    planetEls[w.id] = g;

    g.addEventListener("click", function () { if (!didPan) openCodex(w.id); });
    g.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openCodex(w.id); } });
    g.addEventListener("mouseenter", function () { setHoverRing(w.ring); if (routeEls[w.id]) routeEls[w.id].classList.add("lit"); });
    g.addEventListener("mouseleave", function () { setHoverRing(null); if (routeEls[w.id]) routeEls[w.id].classList.remove("lit"); });
  });

  // ---------- hover-orbit motion ----------
  var ringCur = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  var ringTarget = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  var MAXDEG = 8, orbitRAF = null;
  function setHoverRing(ring) {
    for (var k = 1; k <= 5; k++) {
      if (ring == null) { ringTarget[k] = 0; continue; }
      var sizeFactor = RING_R[1] / RING_R[k];     // bigger rings turn fewer degrees
      ringTarget[k] = MAXDEG * sizeFactor * (k === ring ? 1.0 : 0.4);
    }
    if (!orbitRAF) orbitRAF = requestAnimationFrame(orbitStep);
  }
  function applyRing(k) {
    var deg = ringCur[k];
    ringGroups[k].setAttribute("transform", "rotate(" + deg + " " + CX + " " + CY + ")");
  }
  function orbitStep() {
    var moving = false;
    for (var k = 1; k <= 5; k++) {
      var d = ringTarget[k] - ringCur[k];
      if (Math.abs(d) > 0.01) { ringCur[k] += d * 0.14; moving = true; } else { ringCur[k] = ringTarget[k]; }
      applyRing(k);
    }
    // keep labels upright: counter-rotate about their own anchor
    for (var id in labelEls) {
      var L = labelEls[id];
      if (L.role === "home") continue;
      L.el.setAttribute("transform", "rotate(" + (-ringCur[L.ring]) + " " + L.x + " " + L.y + ")");
    }
    // keep potion-routes attached to the moving planets
    var hub1 = hub ? rot(hub._x, hub._y, ringCur[1]) : { x: CX, y: CY };
    for (var i = 0; i < routeInfo.length; i++) {
      var ri = routeInfo[i], p = rot(ri.tx, ri.ty, ringCur[ri.world.ring]);
      var from = (ri.world.role === "hub") ? { x: CX, y: CY } : hub1;
      ri.line.setAttribute("x1", from.x); ri.line.setAttribute("y1", from.y);
      ri.line.setAttribute("x2", p.x); ri.line.setAttribute("y2", p.y);
    }
    if (moving) { orbitRAF = requestAnimationFrame(orbitStep); } else { orbitRAF = null; }
  }

  // ---------- legend + filter ----------
  var counts = {};
  worlds.forEach(function (w) { counts[w.category] = (counts[w.category] || 0) + 1; });
  var activeFilter = null;
  CAT_ORDER.forEach(function (cat) {
    var li = document.createElement("li");
    li.dataset.cat = cat;
    li.innerHTML = '<span class="dot" style="background:' + CAT[cat].raw + ';color:' + CAT[cat].raw + '"></span><span>' + CAT[cat].label + '</span><span class="n">' + (counts[cat] || 0) + '</span>';
    li.addEventListener("click", function () { toggleFilter(cat); });
    legendList.appendChild(li);
  });
  function toggleFilter(cat) {
    activeFilter = (activeFilter === cat) ? null : cat;
    svg.classList.toggle("filtered", !!activeFilter);
    worlds.forEach(function (w) {
      var on = !activeFilter || w.category === activeFilter || w.role === "home";
      planetEls[w.id].classList.toggle("off", !on);
      if (routeEls[w.id]) routeEls[w.id].classList.toggle("off", !on);
    });
    Array.prototype.forEach.call(legendList.children, function (li) {
      li.classList.toggle("dim", !!activeFilter && li.dataset.cat !== cat);
    });
  }

  // ---------- codex ----------
  var selId = null;
  function openCodex(id) {
    var w = worlds.find(function (x) { return x.id === id; });
    if (!w) return;
    if (selId && planetEls[selId]) planetEls[selId].classList.remove("sel");
    selId = id; planetEls[id].classList.add("sel");
    var cc = CAT[w.category], imgUri = resolveImage(w);
    var h = "";
    h += '<button class="cx-close" type="button" aria-label="Close">×</button>';
    h += '<div class="cx-hero">' + (imgUri ? '<img src="' + imgUri + '" alt="' + esc(w.name) + '">' : '<div class="noimg">No illustration yet</div>') + '</div>';
    h += '<div class="cx-body">';
    h += '<span class="cx-cat" style="color:' + cc.raw + '"><span class="dot" style="background:' + cc.raw + '"></span>' + esc(cc.label) + '</span>';
    h += '<h2>' + esc(w.name) + '</h2>';
    h += '<div class="cx-meta"><span><b>' + w.storyCount + '</b> ' + (w.storyCount === 1 ? "story" : "stories") + '</span>';
    if (w.earliestDate) h += '<span>first visited <b>' + esc(fmtDate(w.earliestDate)) + '</b></span>';
    h += '</div>';
    h += '<p class="cx-desc">' + esc(w.curatedDescription) + '</p>';
    var p = w.potion || {};
    if (p.rhyme || p.mechanic) {
      h += '<div class="spell">';
      h += p.rhyme ? '<span class="lead">Say the rhyme</span><div class="rhyme">“' + esc(p.rhyme) + '”</div>' : '<span class="lead">How they arrive</span>';
      if (p.name) h += '<span class="pname">Potion: ' + esc(p.name) + '</span>';
      if (p.mechanic) h += '<p class="mech">' + esc(p.mechanic) + '</p>';
      h += '</div>';
    }
    if (w.quotes && w.quotes.length) {
      h += '<span class="cx-section-label">From the tapes</span><div class="qwrap">';
      w.quotes.forEach(function (q) {
        var qt = String(q.text || "").replace(/^["“](.*)["”]$/s, "$1").trim();
        h += '<blockquote class="pullquote"><span class="q">“' + esc(qt) + '”</span><span class="attr">— <b>' + esc(q.speaker) + '</b></span></blockquote>';
      });
      h += '</div>';
    }
    if (w.characters && w.characters.length) {
      h += '<span class="cx-section-label">Who you meet</span><div class="chips">';
      w.characters.forEach(function (c) { h += '<span class="chip">' + esc(c) + '</span>'; });
      h += '</div>';
    }
    if (w.stories && w.stories.length) {
      h += '<span class="cx-section-label">' + (w.stories.length === 1 ? "The story" : "The stories") + '</span><ul class="stories">';
      w.stories.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).forEach(function (s) {
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
    if (selId && planetEls[selId]) planetEls[selId].classList.remove("sel");
    selId = null;
    setTimeout(function () { codex.hidden = true; scrim.hidden = true; }, 420);
  }
  scrim.addEventListener("click", closeCodex);

  // ---------- zoom + pan (viewBox camera) ----------
  var baseView = { x: -40, y: -40, w: 1080, h: 1080 };
  var cam = { x: baseView.x, y: baseView.y, w: baseView.w, h: baseView.h };
  var MINW = 380;
  function applyCam() { svg.setAttribute("viewBox", cam.x + " " + cam.y + " " + cam.w + " " + cam.h); }
  function clampPan() {
    var M = 160;
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
    cam.x = vx - px * newW; cam.y = vy - py * newW; cam.w = newW; cam.h = newW;
    clampPan(); applyCam();
  }
  svg.addEventListener("wheel", onWheel, { passive: false });

  var dragging = false, didPan = false, sx = 0, sy = 0, sCam = null;
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

  // ---------- intro ----------
  function hideIntro() { intro.classList.add("hide"); }
  intro.querySelector("button").addEventListener("click", hideIntro);
  function onKey(e) {
    if (e.key === "Escape") { if (!codex.hidden) closeCodex(); else hideIntro(); }
    else if (e.key === "0") resetZoom();
  }
  document.addEventListener("keydown", onKey);

  // ---------- starfield ----------
  var ctx = canvas.getContext("2d"), stars = [], W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2), starRAF = null, t0 = null;
  function resize() {
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = Math.round(W * H / 5200); stars = [];
    for (var i = 0; i < n; i++) stars.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.3 + 0.2, base: Math.random() * 0.5 + 0.25, tw: Math.random() * Math.PI * 2, sp: Math.random() * 0.8 + 0.3, gold: Math.random() < 0.12 });
  }
  function draw(ts) {
    if (t0 === null) t0 = ts;
    var t = (ts - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i], a = reduce ? s.base : s.base * (0.6 + 0.4 * Math.sin(s.tw + t * s.sp));
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = s.gold ? "rgba(246,217,164," + a + ")" : "rgba(233,238,255," + a + ")"; ctx.fill();
    }
    if (!reduce) starRAF = requestAnimationFrame(draw);
  }
  function onResize() { resize(); if (reduce) draw(performance.now()); }
  window.addEventListener("resize", onResize);
  resize();
  starRAF = requestAnimationFrame(draw);

  // ---------- cleanup ----------
  return function cleanup() {
    if (starRAF) cancelAnimationFrame(starRAF);
    if (orbitRAF) cancelAnimationFrame(orbitRAF);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.removeEventListener("keydown", onKey);
    root.innerHTML = ""; root.classList.remove("cosmos");
  };
}
