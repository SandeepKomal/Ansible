// The Architecture tab: a diagram of an Ansible run in which every component
// can be pointed at, tapped or reached with Tab to read what it does and how it fails.
"use strict";

(function () {
  const { h, rich, practise } = window.AQUI;
  const parts = Object.fromEntries(window.QUEST.architecture.components.map((c) => [c.id, c]));
  const titles = Object.fromEntries(window.AQScenarios.SCENARIOS.map((x) => [x.id, x.title]));
  const root = document.getElementById("arch");

  const NS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    el.append(...kids);
    return el;
  }

  // Two hand-placed layouts. Boxes are [x, y, width, height]; an id after @
  // repeats a component on another host.
  const LAYOUTS = {
    wide: {
      size: [1040, 470], font: [13, 11],
      panels: [["Control node", 20, 20, 600, 430, "control"], ["Over SSH", 640, 20, 150, 430, "wire"], ["Managed nodes", 810, 20, 210, 430, "node"],
        ["web-01", 820, 50, 190, 150, "host"], ["db-01", 820, 230, 190, 150, "host"]],
      boxes: {
        cli: [40, 60, 170, 56], inventory: [230, 60, 170, 56], vars: [420, 60, 170, 56],
        playbook: [40, 170, 170, 56], collections: [230, 170, 170, 56], vault: [420, 170, 170, 56], callback: [40, 330, 170, 56],
        connection: [655, 140, 120, 56], become: [655, 250, 120, 56],
        "module@1": [830, 80, 170, 46], "facts@1": [830, 140, 170, 46], "module@2": [830, 260, 170, 46], "facts@2": [830, 320, 170, 46]
      },
      edges: [
        ["cli", "inventory", [[210, 88], [230, 88]]], ["inventory", "vars", [[400, 88], [420, 88]]], ["vars", "vault", [[505, 116], [505, 170]]],
        ["cli", "playbook", [[125, 116], [125, 170]]], ["playbook", "collections", [[210, 198], [230, 198]]],
        ["collections", "connection", [[315, 226], [315, 255], [620, 255], [620, 168], [655, 168]]], ["connection", "become", [[715, 196], [715, 250]]],
        ["connection", "module@1", [[775, 158], [800, 158], [800, 103], [830, 103]]], ["module@1", "facts@1", [[915, 126], [915, 140]]],
        ["connection", "module@2", [[775, 178], [800, 178], [800, 283], [830, 283]]], ["module@2", "facts@2", [[915, 306], [915, 320]]],
        ["connection", "callback", [[655, 186], [632, 186], [632, 358], [210, 358]]]
      ]
    },
    narrow: {
      size: [360, 900], font: [12, 10],
      panels: [["Control node", 5, 10, 350, 440, "control"], ["Over SSH", 5, 470, 350, 110, "wire"], ["Managed nodes", 5, 600, 350, 290, "node"],
        ["web-01", 15, 630, 330, 120, "host"], ["db-01", 15, 760, 330, 120, "host"]],
      boxes: {
        cli: [20, 50, 150, 50], inventory: [190, 50, 150, 50], vars: [190, 140, 150, 50], vault: [190, 230, 150, 50],
        playbook: [20, 140, 150, 50], collections: [20, 230, 150, 50], callback: [20, 330, 150, 50],
        connection: [20, 505, 150, 50], become: [190, 505, 150, 50],
        "module@1": [30, 665, 140, 46], "facts@1": [190, 665, 140, 46], "module@2": [30, 795, 140, 46], "facts@2": [190, 795, 140, 46]
      },
      edges: [
        ["cli", "inventory", [[170, 75], [190, 75]]], ["inventory", "vars", [[265, 100], [265, 140]]], ["vars", "vault", [[265, 190], [265, 230]]],
        ["cli", "playbook", [[95, 100], [95, 140]]], ["playbook", "collections", [[95, 190], [95, 230]]],
        ["collections", "connection", [[150, 280], [150, 300], [180, 300], [180, 490], [95, 490], [95, 505]]], ["connection", "become", [[170, 530], [190, 530]]],
        ["connection", "module@1", [[95, 555], [95, 665]]], ["module@1", "facts@1", [[170, 688], [190, 688]]],
        ["connection", "module@2", [[40, 555], [40, 580], [12, 580], [12, 818], [30, 818]]], ["module@2", "facts@2", [[170, 818], [190, 818]]],
        ["connection", "callback", [[60, 505], [60, 420], [95, 420], [95, 380]]]
      ]
    }
  };
  const idOf = (key) => key.split("@")[0];

  const TOUR = [
    [[["cli", "inventory"]], "You run ansible-playbook. It reads ansible.cfg and loads the inventory."],
    [[["inventory", "vars"], ["vars", "vault"]], "It merges group_vars and host_vars in precedence order, decrypting Vault values with the password you gave."],
    [[["cli", "playbook"], ["playbook", "collections"]], "It parses the playbook and roles, and finds every module in the installed collections. Errors here stop the run before any host is touched."],
    [[["collections", "connection"]], "For each task it renders the arguments with each host's variables and hands the module to the connection plugin."],
    [[["connection", "become"]], "SSH logs in as ansible_user, checking the host key; become wraps the command in sudo."],
    [[["connection", "module@1"], ["module@1", "facts@1"]], "On web-01 the module runs with Python, using the facts gathered at the start of the play."],
    [[["connection", "module@2"]], "Up to forks hosts at a time: db-01 runs the same task in parallel."],
    [[["connection", "callback"]], "Each module returns JSON. The callback prints ok, changed or failed, runs handlers, and ends with the recap."]
  ];

  const figure = h("div.arch-figure");
  const tip = h("div.arch-tip", { "aria-hidden": "true" });
  const detail = h("div.arch-detail", { hidden: true, "aria-live": "polite" });
  const play = h("button.pill.small-pill", { type: "button", onclick: () => (touring ? stopTour() : tour()) }, "Follow a playbook run");
  const caption = h("p.arch-caption", { "aria-live": "polite" }, "Point at any component to see what it does and what it talks to.");
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let svg = null, dot = null, pinned = null, touring = 0;

  function draw() {
    const L = LAYOUTS[matchMedia("(max-width: 720px)").matches ? "narrow" : "wide"];
    const [w, ht] = L.size;
    const arrow = (id) => s("marker", { id, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, s("path", { d: "M0 0 8 4 0 8z" }));
    svg = s("svg", { viewBox: `0 0 ${w} ${ht}`, class: "arch-svg", role: "group", "aria-label": "How an Ansible run works" }, s("defs", null, arrow("arch-arrow"), arrow("arch-arrow-on")));
    for (const [label, x, y, pw, ph, kind] of L.panels) svg.append(s("rect", { x, y, width: pw, height: ph, rx: 16, class: `arch-panel arch-${kind}` }), s("text", { x: x + 14, y: y + 20, class: "arch-panel-label" }, label));
    for (const [from, to, pts] of L.edges) svg.append(s("polyline", { points: pts.join(" "), class: "arch-edge", "data-from": from, "data-to": to, "marker-end": "url(#arch-arrow)" }));
    for (const [key, [x, y, bw, bh]] of Object.entries(L.boxes)) {
      const c = parts[idOf(key)];
      const g = s("g", { class: "arch-box", "data-id": c.id },
        s("rect", { x, y, width: bw, height: bh, rx: 10 }),
        s("text", { x: x + bw / 2, y: y + bh / 2 - 2, class: "arch-name", "font-size": L.font[0] }, c.name),
        s("text", { x: x + bw / 2, y: y + bh / 2 + L.font[1] + 3, class: "arch-short", "font-size": L.font[1] }, c.short));
      if (!svg.querySelector(`[data-id="${c.id}"]`)) { g.setAttribute("tabindex", "0"); g.setAttribute("role", "button"); g.setAttribute("aria-label", `${c.name}: ${c.short}`); }
      g.addEventListener("mouseenter", () => touring || select(c.id));
      g.addEventListener("focus", () => touring || select(c.id));
      g.addEventListener("click", () => { stopTour(); pinned = c.id; select(c.id); open(c.id); });
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.dispatchEvent(new Event("click")); } });
      svg.append(g);
    }
    dot = s("circle", { r: 6, class: "arch-dot" });
    svg.append(dot);
    svg.addEventListener("mouseleave", () => touring || select(pinned));
    figure.replaceChildren(svg, tip, h("div.arch-tour", null, play, caption));
    stopTour();
    select(pinned);
  }

  // Light up components and edges; with one id, its neighbours too.
  function light(ids, edges) {
    svg.classList.toggle("has-focus", ids.length > 0);
    const near = new Set(ids);
    svg.querySelectorAll(".arch-edge").forEach((e) => {
      const ends = [idOf(e.dataset.from), idOf(e.dataset.to)];
      const on = edges ? edges.includes(e) : ends.some((x) => ids.includes(x));
      if (on) ends.forEach((x) => near.add(x));
      e.classList.toggle("is-on", on);
      e.setAttribute("marker-end", `url(#arch-arrow${on ? "-on" : ""})`);
    });
    svg.querySelectorAll(".arch-box").forEach((g) => { g.classList.toggle("is-on", ids.includes(g.dataset.id)); g.classList.toggle("is-near", !ids.includes(g.dataset.id) && near.has(g.dataset.id)); });
  }
  function select(id) { light(id ? [id] : []); place(id); }

  function open(id) {
    const c = parts[id];
    const ids = c.practise.filter((x) => titles[x]);
    detail.replaceChildren(h("div.card", null, h("p.arch-where", null, c.where), h("h3", null, c.name), h("p", null, c.role),
      h("h4", null, "What it does"), h("ul", null, c.does.map((d) => h("li", null, ...rich(d)))),
      h("h4", null, "When it breaks"), h("p", null, ...rich(c.breaks)),
      h("h4", null, "Look at it"), h("pre", null, h("code", null, c.look.join("\n"))),
      ids.length ? h("div.practise", null, h("span.muted.small", null, "Practise in the playground:"), ids.map((x) => h("button.chip", { type: "button", onclick: () => practise(x) }, titles[x]))) : null));
    detail.hidden = false;
    detail.scrollIntoView({ block: "nearest", behavior: still() ? "auto" : "smooth" });
  }

  // On hover, a short tip beside the component; touch screens go straight to the click.
  function place(id) {
    const showTip = id && figure.offsetParent && !matchMedia("(max-width: 720px), (hover: none)").matches;
    tip.classList.toggle("is-shown", Boolean(showTip));
    if (!showTip) return;
    const c = parts[id];
    tip.replaceChildren(h("p.arch-where", null, c.where), h("h3", null, c.name), h("p", null, c.role), h("p", null, h("strong", null, "When it breaks: "), ...rich(c.breaks)), h("p.muted.small", null, "Click for commands and practice"));
    const box = svg.querySelector(`[data-id="${id}"] rect`).getBoundingClientRect();
    const frame = figure.getBoundingClientRect();
    const right = box.right - frame.left + 12;
    const left = right + tip.offsetWidth <= frame.width ? right : Math.max(0, box.left - frame.left - tip.offsetWidth - 12);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.min(Math.max(0, box.top - frame.top - 8), Math.max(0, frame.height - tip.offsetHeight - 60))}px`;
  }

  // Move the dot along an edge.
  function travel(from, to, run) {
    const e = [...svg.querySelectorAll(".arch-edge")].find((x) => x.dataset.from === from && x.dataset.to === to);
    const pts = e.getAttribute("points").split(" ").map((p) => p.split(",").map(Number));
    const segs = pts.slice(1).map((p, i) => [pts[i], p, Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1])]);
    const total = segs.reduce((n, sg) => n + sg[2], 0);
    const at = (d) => { for (const [a, b, len] of segs) { if (d <= len) return [a[0] + (b[0] - a[0]) * d / len, a[1] + (b[1] - a[1]) * d / len]; d -= len; } return pts[pts.length - 1]; };
    dot.classList.add("is-on");
    return { edge: e, done: new Promise((resolve) => {
      if (still()) { [dot.cx.baseVal.value, dot.cy.baseVal.value] = pts[pts.length - 1]; return resolve(); }
      const ms = Math.max(450, total * 2.2), start = performance.now();
      const frame = (now) => {
        if (run !== touring) return resolve();
        const t = Math.min(1, (now - start) / ms), ease = t < .5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
        [dot.cx.baseVal.value, dot.cy.baseVal.value] = at(total * ease);
        if (t < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    }) };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function tour() {
    const run = ++touring;
    pinned = null;
    place(null);
    play.textContent = "Stop";
    for (const [n, [hops, text]] of TOUR.entries()) {
      caption.replaceChildren(h("span.arch-step", null, `${n + 1} of ${TOUR.length}`), text);
      const edges = [];
      for (const [from, to] of hops) {
        const leg = travel(from, to, run);
        edges.push(leg.edge);
        light([...new Set(hops.flat().map(idOf))], edges);
        await leg.done;
        if (run !== touring) return;
      }
      await wait(still() ? 3200 : 1500);
      if (run !== touring) return;
    }
    stopTour("Played. Point at any component to read more, or play it again.");
  }
  function stopTour(text) {
    touring = 0;
    if (dot) dot.classList.remove("is-on");
    play.textContent = "Follow a playbook run";
    if (text) caption.textContent = text;
    if (svg) light([]);
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (pinned || touring)) { pinned = null; stopTour(); select(null); } });
  matchMedia("(max-width: 720px)").addEventListener("change", draw);
  window.addEventListener("hashchange", () => { if (location.hash !== "#arch") stopTour(); });
  draw();
  root.replaceChildren(figure, detail);
})();
