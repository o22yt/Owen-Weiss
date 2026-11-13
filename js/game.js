/* Silhouette — a daily country guessing game. */
(() => {
  "use strict";

  const MAX_GUESSES = 6;
  const EPOCH = Date.UTC(2026, 0, 1); // puzzle #1
  const SHUFFLE_SEED = 20260101;
  const EARTH_KM = 6371;
  const W = 600, H = 400, PAD = 36;
  const STATE_KEY = "silhouette-state-v1";
  const STATS_KEY = "silhouette-stats-v1";

  // ---------- data ----------
  const COUNTRIES = window.COUNTRIES;
  const byId = new Map(COUNTRIES.map((c) => [c.id, c]));
  const topo = window.WORLD_TOPO;
  const geoms = topo.objects.countries.geometries;
  const allFeatures = topojson.feature(topo, topo.objects.countries).features;

  function featureFor(id) {
    return topojson.merge(topo, geoms.filter((g) => g.id === id));
  }

  // ---------- daily selection ----------
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function dailyPool() {
    const pool = COUNTRIES.filter((c) => c.daily).map((c) => c.id).sort();
    const rand = mulberry32(SHUFFLE_SEED);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool; // every country appears once before any repeats
  }
  function todayIndex() {
    const params = new URLSearchParams(location.search);
    const d = params.get("date") ? new Date(params.get("date") + "T00:00") : new Date();
    const day = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EPOCH) / 864e5);
    return isNaN(day) ? 0 : day;
  }
  const DAY = todayIndex();
  const POOL = dailyPool();
  const ANSWER = byId.get(POOL[((DAY % POOL.length) + POOL.length) % POOL.length]);

  // ---------- storage (best effort) ----------
  const store = {
    get(k, fallback) {
      try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  let state = store.get(STATE_KEY, null);
  if (!state || state.day !== DAY || state.answer !== ANSWER.id) {
    state = { day: DAY, answer: ANSWER.id, guesses: [], status: "playing" };
  }
  const saveState = () => store.set(STATE_KEY, state);

  // ---------- geometry helpers ----------
  const rad = (d) => (d * Math.PI) / 180;
  function distanceKm(a, b) {
    return d3.geoDistance([a[1], a[0]], [b[1], b[0]]) * EARTH_KM;
  }
  function bearing(a, b) {
    const [la1, lo1, la2, lo2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
    const y = Math.sin(lo2 - lo1) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
    return (Math.atan2(y, x) * 180) / Math.PI;
  }
  const ARROWS = ["⬆️", "↗️", "➡️", "↘️", "⬇️", "↙️", "⬅️", "↖️"];
  const arrowFor = (deg) => ARROWS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

  /* Keep only the main landmass cluster (drops e.g. French Guiana from France,
     Alaska/Hawaii from the USA) so the silhouette fills the frame. */
  function mainCluster(feature, maxKm = 2200) {
    const g = feature.geometry;
    if (g.type !== "MultiPolygon") return feature;
    const polys = g.coordinates.map((c) => ({ type: "Polygon", coordinates: c }));
    const largest = polys.reduce((a, b) => (d3.geoArea(b) > d3.geoArea(a) ? b : a));
    const center = d3.geoCentroid(largest);
    const kept = polys.filter((p) => d3.geoDistance(d3.geoCentroid(p), center) * EARTH_KM < maxKm);
    return { type: "Feature", geometry: { type: "MultiPolygon", coordinates: kept.map((p) => p.coordinates) } };
  }

  // ---------- map ----------
  const svg = d3.select("#map");
  const targetFeature = featureFor(ANSWER.id);
  const focus = mainCluster({ type: "Feature", geometry: targetFeature });
  const center = d3.geoCentroid(focus);
  const projection = d3.geoAzimuthalEqualArea()
    .rotate([-center[0], -center[1]])
    .clipAngle(100)
    .fitExtent([[PAD, PAD], [W - PAD, H - PAD]], focus);
  const closeScale = projection.scale();
  // Zoom out ~3x, but always far enough to show at least ~1,500 km across.
  const farScale = Math.min(closeScale / 3.2, W / (1500 / EARTH_KM));
  const path = d3.geoPath(projection);

  const gContext = svg.append("g");
  const gTarget = svg.append("g");
  const contextPaths = gContext.selectAll("path")
    .data(allFeatures.filter((f) => f.id !== ANSWER.id))
    .join("path").attr("class", "context").style("opacity", 0);
  const targetPath = gTarget.append("path").datum(targetFeature).attr("class", "target");

  let zoomedOut = false;
  function redraw() {
    targetPath.attr("d", path);
    if (zoomedOut) contextPaths.attr("d", path);
  }
  function setZoom(out, animate = true) {
    if (out === zoomedOut && animate) return;
    zoomedOut = out;
    const from = projection.scale(), to = out ? farScale : closeScale;
    if (out) contextPaths.attr("d", path);
    if (!animate) { projection.scale(to); redraw(); contextPaths.style("opacity", out ? 1 : 0); return; }
    contextPaths.transition().duration(900).style("opacity", out ? 1 : 0);
    svg.transition().duration(1100).ease(d3.easeCubicInOut).tween("zoom", () => {
      const i = d3.interpolate(from, to);
      return (t) => { projection.scale(i(t)); targetPath.attr("d", path); contextPaths.attr("d", path); };
    });
  }
  function markGuessedOnMap() {
    const wrong = new Set(state.guesses.filter((g) => g !== ANSWER.id));
    contextPaths.classed("guessed", (d) => wrong.has(d.id));
  }

  // ---------- clues ----------
  const fmt = new Intl.NumberFormat("en-US");
  const list = (arr) => arr.length <= 1 ? (arr[0] || "—") : arr.slice(0, -1).join(", ") + " and " + arr.at(-1);
  const flagUrl = (c) => (window.FLAGS && window.FLAGS[c.cca2]) || "";
  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function sizeComparison(area) {
    const refs = [["Texas", 695662, "-"], ["France", 551695, "FRA"], ["the UK", 242495, "GBR"], ["Portugal", 92212, "PRT"],
      ["Belgium", 30528, "BEL"], ["Luxembourg", 2586, "LUX"], ["Andorra", 468, "AND"]].filter((r) => r[2] !== ANSWER.id);
    const [name, a] = refs.find(([, a]) => area >= a * 0.35) || refs.at(-1);
    const r = area / a;
    if (r > 1.15) return `about ${r >= 10 ? Math.round(r) : r.toFixed(1)}× the size of ${name}`;
    if (r < 0.87) return `about ${Math.round(r * 100)}% the size of ${name}`;
    return `roughly the size of ${name}`;
  }

  const a = ANSWER;
  const CLUES = [
    {
      title: "Region",
      body: () => {
        const ns = a.latlng[0] >= 0 ? "Northern" : "Southern";
        const ew = a.latlng[1] >= 0 ? "Eastern" : "Western";
        return `<p>${a.subregion}${a.subregion !== a.region ? ` (${a.region})` : ""} — ${ns} &amp; ${ew} Hemispheres.</p>`;
      },
    },
    {
      title: "Neighbours",
      onReveal: (animate) => setZoom(true, animate),
      body: () => {
        const n = a.borders.length;
        const border = n === 0 ? "It has no land borders" : `It borders ${n} ${n === 1 ? "country" : "countries"}`;
        const coast = a.landlocked ? "and is landlocked" : n === 0 ? "— it's surrounded by sea" : "and has a coastline";
        return `<p>The map has zoomed out. ${border} ${coast}.</p>`;
      },
    },
    {
      title: "Size",
      body: () => `<p>${fmt.format(Math.round(a.area))} km² — ${sizeComparison(a.area)}. It's the ${ordinal(a.areaRank)} largest of ${COUNTRIES.length} countries.</p>`,
    },
    {
      title: "Language, currency & capital",
      body: () => {
        const cap = a.capital[0] ? `The capital starts with <strong>“${a.capital[0][0]}”</strong>.` : "";
        return `<p>Speaks ${list(a.languages.slice(0, 4))}. Pays in ${list(a.currencies)}. ${cap}</p>`;
      },
    },
    {
      title: "Flag",
      body: () => `<img class="flag" src="${flagUrl(a)}" alt="Flag of the mystery country" onerror="this.replaceWith(document.createTextNode('${a.flag}'))" />`,
    },
  ];

  const $ = (s) => document.querySelector(s);
  const cluesEl = $("#clues");
  let shownClues = 0;
  function cluesUnlocked() {
    const wrong = state.guesses.filter((g) => g !== ANSWER.id).length;
    return state.status === "playing" ? Math.min(wrong, CLUES.length) : CLUES.length;
  }
  function renderClues(animate) {
    const n = cluesUnlocked();
    cluesEl.innerHTML = CLUES.map((c, i) => i < n
      ? `<div class="clue${animate && i >= shownClues ? " fresh" : ""}"><span class="num">${i + 1}</span><div><h3>${c.title}</h3>${c.body()}</div></div>`
      : `<div class="clue locked"><span class="num">${i + 1}</span><div><h3>Locked</h3><p>Unlocks after ${i + 1} wrong ${i ? "guesses" : "guess"}.</p></div></div>`
    ).join("");
    for (let i = shownClues; i < n; i++) CLUES[i].onReveal?.(animate);
    shownClues = n;
    $("#clue-count").textContent = `· ${n}/${CLUES.length}`;
  }

  // ---------- guesses ----------
  const guessesEl = $("#guesses");
  function guessInfo(id) {
    const c = byId.get(id);
    const d = id === ANSWER.id ? 0 : distanceKm(c.latlng, ANSWER.latlng);
    const pct = Math.max(0, Math.round(100 * (1 - d / 20015)));
    return { c, d, pct, arrow: d === 0 ? "🎯" : arrowFor(bearing(c.latlng, ANSWER.latlng)) };
  }
  function renderGuesses() {
    const rows = state.guesses.map((id) => {
      const { c, d, pct, arrow } = guessInfo(id);
      const ok = id === ANSWER.id;
      return `<li class="guess${ok ? " correct" : ""}"><span class="name">${c.name}</span>
        <span class="dist">${ok ? "—" : fmt.format(Math.round(d)) + " km"}</span>
        <span class="arrow" aria-label="direction">${arrow}</span><span class="pct">${pct}%</span></li>`;
    });
    for (let i = state.guesses.length; i < MAX_GUESSES; i++) rows.push(`<li class="guess empty"></li>`);
    guessesEl.innerHTML = rows.join("");
  }

  // ---------- input + autocomplete ----------
  const input = $("#guess-input"), sugEl = $("#suggestions"), msgEl = $("#message");
  const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const searchIndex = COUNTRIES.map((c) => ({ c, keys: [c.name, ...c.aliases].map(norm) }));
  let matches = [], active = 0;

  function findMatches(q) {
    q = norm(q);
    if (!q) return [];
    const scored = [];
    for (const { c, keys } of searchIndex) {
      let best = Infinity;
      keys.forEach((k, i) => {
        if (k === q) best = Math.min(best, i ? 1 : 0);
        else if (k.startsWith(q)) best = Math.min(best, i ? 3 : 2);
        else if (k.split(" ").some((w) => w.startsWith(q))) best = Math.min(best, i ? 5 : 4);
        else if (q.length > 2 && k.includes(q)) best = Math.min(best, 6);
      });
      if (best < Infinity) scored.push([best, c]);
    }
    return scored.sort((x, y) => x[0] - y[0] || x[1].name.localeCompare(y[1].name)).slice(0, 8).map((s) => s[1]);
  }
  function renderSuggestions() {
    if (!matches.length) { sugEl.hidden = true; input.setAttribute("aria-expanded", "false"); return; }
    sugEl.innerHTML = matches.map((c, i) => {
      const used = state.guesses.includes(c.id);
      return `<li role="option" data-id="${c.id}" aria-selected="${i === active}">${c.name}${used ? "<small>already guessed</small>" : ""}</li>`;
    }).join("");
    sugEl.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }
  input.addEventListener("input", () => { matches = findMatches(input.value); active = 0; renderSuggestions(); msgEl.textContent = ""; });
  input.addEventListener("keydown", (e) => {
    if (sugEl.hidden) return;
    if (e.key === "ArrowDown") { active = (active + 1) % matches.length; renderSuggestions(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = (active - 1 + matches.length) % matches.length; renderSuggestions(); e.preventDefault(); }
    else if (e.key === "Escape") { matches = []; renderSuggestions(); }
  });
  sugEl.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (li) { e.preventDefault(); submitGuess(li.dataset.id); }
  });
  input.addEventListener("blur", () => setTimeout(() => { matches = []; renderSuggestions(); }, 100));
  $("#guess-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const exact = searchIndex.find(({ keys }) => keys.includes(norm(input.value)));
    const pick = (exact && exact.c) || matches[active] || findMatches(input.value)[0];
    if (!pick) return reject(input.value.trim() ? "That's not a country on the list." : "Type a country name.");
    submitGuess(pick.id);
  });

  function reject(msg) {
    msgEl.textContent = msg;
    input.classList.remove("shake"); void input.offsetWidth; input.classList.add("shake");
  }

  function submitGuess(id) {
    if (state.status !== "playing") return;
    if (state.guesses.includes(id)) return reject(`You already guessed ${byId.get(id).name}.`);
    state.guesses.push(id);
    input.value = ""; matches = []; renderSuggestions();
    const correct = id === ANSWER.id;
    if (correct) state.status = "won";
    else if (state.guesses.length >= MAX_GUESSES) state.status = "lost";
    msgEl.textContent = correct ? "" : state.status === "lost" ? "" : `Not ${byId.get(id).name}. A new clue is unlocked!`;
    saveState();
    if (state.status !== "playing") recordStats();
    render(true);
    if (state.status !== "playing") setTimeout(showResult, 1400);
  }

  // ---------- stats ----------
  function getStats() {
    return store.get(STATS_KEY, { played: 0, wins: 0, streak: 0, maxStreak: 0, dist: Array(MAX_GUESSES).fill(0), lastDay: null, lastWinDay: null });
  }
  function recordStats() {
    const s = getStats();
    if (s.lastDay === DAY) return;
    s.played++;
    s.lastDay = DAY;
    if (state.status === "won") {
      s.wins++;
      s.streak = s.lastWinDay === DAY - 1 ? s.streak + 1 : 1;
      s.maxStreak = Math.max(s.maxStreak, s.streak);
      s.dist[state.guesses.length - 1]++;
      s.lastWinDay = DAY;
    } else s.streak = 0;
    store.set(STATS_KEY, s);
  }
  function statsHtml() {
    const s = getStats();
    const streak = s.lastWinDay === DAY || s.lastWinDay === DAY - 1 ? s.streak : 0;
    const max = Math.max(1, ...s.dist);
    const hl = state.status === "won" ? state.guesses.length - 1 : -1;
    return `<h2>Statistics</h2>
      <div class="stats-row">
        <div><b>${s.played}</b><span>Played</span></div>
        <div><b>${s.played ? Math.round((100 * s.wins) / s.played) : 0}</b><span>Win %</span></div>
        <div><b>${streak}</b><span>Streak</span></div>
        <div><b>${s.maxStreak}</b><span>Best</span></div>
      </div>
      <h3 class="section-title" style="margin-top:0">Guess distribution</h3>
      ${s.dist.map((n, i) => `<div class="dist-row"><span>${i + 1}</span><div class="dist-bar${i === hl ? " hl" : ""}" style="width:${Math.max(8, (100 * n) / max)}%">${n}</div></div>`).join("")}`;
  }

  // ---------- result / share ----------
  function shareText() {
    const rows = state.guesses.map((id) => {
      const { pct, arrow } = guessInfo(id);
      const full = Math.floor(pct / 20);
      return "🟩".repeat(full) + (pct % 20 >= 10 && full < 5 ? "🟨" : "") + "⬜".repeat(Math.max(0, 5 - full - (pct % 20 >= 10 && full < 5 ? 1 : 0))) + " " + arrow;
    });
    const score = state.status === "won" ? state.guesses.length : "X";
    return `Silhouette #${DAY + 1} ${score}/${MAX_GUESSES}\n${rows.join("\n")}`;
  }
  function countdown() {
    const now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const s = Math.max(0, Math.floor((next - now) / 1000));
    return [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, "0")).join(":");
  }
  let timer;
  function showResult() {
    const won = state.status === "won";
    const n = state.guesses.length;
    $("#result-body").innerHTML = `
      <h2>${won ? (n === 1 ? "First try! 🤯" : `Got it in ${n}!`) : "Out of guesses"}</h2>
      <p>${won ? "Today's country was" : "The answer was"} <strong>${a.name}</strong>.</p>
      <img class="result-flag" src="${flagUrl(a)}" alt="Flag of ${a.name}" onerror="this.remove()" />
      <dl class="facts">
        <dt>Capital</dt><dd>${list(a.capital)}</dd>
        <dt>Region</dt><dd>${a.subregion}</dd>
        <dt>Area</dt><dd>${fmt.format(Math.round(a.area))} km²</dd>
        <dt>Languages</dt><dd>${list(a.languages)}</dd>
      </dl>
      ${statsHtml()}
      <div class="actions">
        <div class="countdown">Next country in<b id="cd">${countdown()}</b></div>
        <button class="share-btn" id="share">Share</button>
      </div>
      <textarea id="share-text" class="share-text" rows="8" readonly hidden></textarea>`;
    clearInterval(timer);
    timer = setInterval(() => { const el = $("#cd"); if (el) el.textContent = countdown(); if (countdown() === "00:00:00") location.reload(); }, 1000);
    $("#share").onclick = () => {
      const text = shareText();
      const fallback = () => {
        const box = $("#share-text");
        box.value = text; box.hidden = false; box.select();
        toast("Select and copy your result");
      };
      try {
        navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard"), fallback);
      } catch { fallback(); }
    };
    $("#dlg-result").showModal();
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1800);
  }

  // ---------- render ----------
  function render(animate) {
    renderGuesses();
    renderClues(animate);
    markGuessedOnMap();
    const done = state.status !== "playing";
    input.disabled = $("#guess-btn").disabled = done;
    input.placeholder = done ? (state.status === "won" ? "Solved! Come back tomorrow." : "Come back tomorrow for a new country.") : `Guess ${state.guesses.length + 1} of ${MAX_GUESSES}…`;
    targetPath.classed("solved", state.status === "won").classed("lost", state.status === "lost");
    const label = $("#map-label");
    label.hidden = !done;
    label.textContent = a.name;
    if (done) setZoom(true, animate);
  }

  $("#puzzle-no").textContent = `#${DAY + 1} · ${new Date(EPOCH + DAY * 864e5).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  redraw();
  render(false);

  // dialogs
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  });
  $("#btn-help").onclick = () => $("#dlg-help").showModal();
  $("#btn-stats").onclick = () => {
    if (state.status !== "playing") return showResult();
    $("#stats-body").innerHTML = statsHtml();
    $("#dlg-stats").showModal();
  };
  if (state.status !== "playing") setTimeout(showResult, 500);
  else if (!store.get("silhouette-seen-help", false)) { store.set("silhouette-seen-help", true); $("#dlg-help").showModal(); }
  else input.focus();
})();
