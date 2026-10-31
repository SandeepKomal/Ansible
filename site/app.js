// DevOps Nimbus Ansible site. No dependencies, no network requests.
"use strict";

(function () {
  const Q = window.TRACK;
  const BANK = window.TRACK_QUIZ_BANK;
  const SCN = window.AQScenarios.SCENARIOS;
  const $ = (sel) => document.querySelector(sel);
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollToEl = (el) => el.scrollIntoView({ block: "start", behavior: still() ? "auto" : "smooth" });

  // h("tag.class", {attr: value}, ...children): build DOM without innerHTML.
  function h(spec, attrs, ...kids) {
    const [tag, ...classes] = spec.split(".");
    const el = document.createElement(tag);
    if (classes.length) el.className = classes.join(" ");
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  // Text with `code` spans.
  const rich = (text) => String(text).split(/(`[^`]+`)/).map((part) => (part.startsWith("`") ? h("code", null, part.slice(1, -1)) : part));

  const PREFIX = "dq-ansible:";
  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(PREFIX + key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* storage blocked */ } }
  };
  function forgetEverything() {
    if (!confirm("Clear your progress, quiz scores and saved names from this browser?")) return;
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k); } catch { /* storage blocked */ }
    location.reload();
  }

  // Copy a permanent link to part of the site.
  function copyLink(hash, label = "Copy link") {
    return h("button.copy", {
      type: "button", "aria-label": label,
      onclick: async (e) => {
        const b = e.currentTarget;
        const url = location.href.split("#")[0] + "#" + hash;
        try { await navigator.clipboard.writeText(url); b.textContent = "Copied"; } catch { b.textContent = url; }
        setTimeout(() => { b.textContent = label; }, 1500);
      }
    }, label);
  }
  const practise = (id) => { location.hash = "play/" + id; };
  const scenarioTitle = Object.fromEntries(SCN.map((s) => [s.id, s.title]));
  const repoFile = (p) => `${Q.repo}/blob/main/${p.split("/").map(encodeURIComponent).join("/")}`;

  document.querySelectorAll("[data-repo]").forEach((a) => { a.href = Q.repo + a.dataset.repo; });

  // --- tabs and deep links -------------------------------------------------------

  const tabs = ["path", "quiz", "xray", "doctor", "cheats", "arch"];
  let current = null;
  function show() {
    const [want, sub] = location.hash.slice(1).split("/");
    const tab = want === "play" ? "path" : want === "fix" ? "doctor" : tabs.includes(want) ? want : "path";
    if (tab !== current) {
      const page = $("#tab-" + tab);
      page.classList.remove("tab-in");
      void page.offsetWidth; // restart the fade
      page.classList.add("tab-in");
    }
    current = tab;
    if (tab !== "path" && flowTimer) stopFlow();
    for (const t of tabs) $("#tab-" + t).hidden = t !== tab;
    document.querySelectorAll(".top nav a").forEach((a) => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    if (want === "fix" && sub) { const i = Q.doctor.findIndex((d) => d.id === sub); if (i >= 0) renderDoctor(i); }
    if (want === "play" && sub && window.AQPlayground) window.AQPlayground.load(sub);
  }
  window.addEventListener("hashchange", () => {
    const before = current;
    show();
    if (current !== before && !/^#(play|fix)\//.test(location.hash)) window.scrollTo(0, 0);
  });

  // --- hero: the play across eight hosts ----------------------------------------------

  function signature() {
    const wait = (ms) => new Promise((r) => setTimeout(r, still() ? 0 : ms));
    const names = ["web-01", "web-02", "web-03", "web-04", "db-01", "db-02", "cache-01", "lb-01"];
    const cards = names.map((n) => h("div.host", null, h("b", null, n), h("span", null, "waiting")));
    const recap = h("div.recap", null, h("span.dim", null, "Run the play to configure eight servers."));
    let runs = 0;
    const button = h("button.toggle", { type: "button" }, "Run the play");
    button.addEventListener("click", async () => {
      button.disabled = true;
      runs++;
      for (const [i, c] of cards.entries()) {
        c.className = "host run";
        c.lastChild.textContent = "running…";
        await wait(180);
        const changed = runs === 1 && i !== 5;
        c.className = "host " + (changed ? "changed" : "ok");
        c.lastChild.textContent = changed ? "ok=12 changed=3" : "ok=12 changed=0";
      }
      recap.replaceChildren(runs === 1
        ? h("span", null, h("span.s-warn", null, "changed=21"), "  Run it again: a well-written play changes nothing the second time.")
        : h("span", null, h("span.s-ok", null, "changed=0"), "  Idempotent: the servers already match the play."));
      button.disabled = false;
      button.textContent = "Run the play again";
    });
    $("#stage").append(h("div.stage-bar", null, h("div", null, h("strong", null, "site.yml"), "ansible-playbook -i inventory site.yml"), button),
      h("div.hosts", null, cards), recap);
  }

  function heroData() {
    const questions = Object.values(BANK).reduce((n, l) => n + l.length, 0);
    $("#stats").replaceChildren(...[[SCN.length, "incidents to fix in the playground"], [Q.levels.length, "levels, first ping to production"], [Q.doctor.length, "errors explained, with the fix"]]
      .map(([n, l]) => h("div", null, h("b", null, String(n)), h("span", null, l))));
    const tiles = [
      ["Playground", "Run plays against a fleet.", "Unreachable hosts, failed handlers, plays that are not idempotent, secrets in logs.", "wide", "#pg-title"],
      ["Playbook X-ray", "Every task, explained.", "Modules, conditions, loops, and the risky ones flagged.", "wide", "#xray"],
      ["Quiz", "Roles, vars, precedence.", `${questions} questions with the reasoning.`, "", "#quiz"],
      ["How a play runs", "Control node to managed hosts.", "What runs where, and how it fails.", "", "#arch"],
      ["Stuck on an error?", "Learn why it happens, then practise the fix.", "Paste what Ansible printed.", "", "#doctor"]
    ];
    $("#bento").replaceChildren(...tiles.map(([k, title, text, size, href]) => h("a.tile" + (size ? "." + size : ""), { href }, h("div", null, h("div.k", null, k), h("h3", null, title)), h("p", null, text))));
  }

  // --- path ------------------------------------------------------------------------

  function renderPath() {
    const done = new Set(store.get("done", []));
    const scores = store.get("quiz", {});
    const box = $("#levels");
    box.replaceChildren();
    let stage = "";
    let list;
    for (const lv of Q.levels) {
      if (lv.stage !== stage) {
        stage = lv.stage;
        list = h("ol.levels");
        box.append(h("h3.stage-title", { id: "stage-" + stage.toLowerCase() }, stage), list);
      }
      const isDone = done.has(lv.id);
      const check = h("input", {
        type: "checkbox", checked: isDone, "aria-label": `Mark level ${lv.id} complete`,
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => { if (e.target.checked) done.add(lv.id); else done.delete(lv.id); store.set("done", [...done]); if (e.target.checked) window.AQEngage.active(); renderPath(); }
      });
      list.append(h("li", { id: "lv-" + lv.id }, h("details.level" + (isDone ? ".done" : ""), { id: "level-" + lv.id },
        h("summary", null, check, h("span.num", null, lv.id), h("span.what", null, h("strong", null, lv.title), h("span.topic", null, lv.topic)), h("span.chev", { "aria-hidden": "true" }, "›")),
        h("div.level-body", null,
          h("div", null, h("h4", null, "What you learn"), h("ul", null, lv.learn.map((t) => h("li", null, ...rich(t))))),
          h("div", null, h("h4", null, "Lab on your machine"), h("p", null, lv.lab.text), window.AQEngage.order(lv, h("pre", null, h("code", null, lv.lab.cmds.join("\n")))),
            h("h4", null, "In this repository"), h("ul", null, lv.refs.map((p) => h("li", null, h("a", { href: repoFile(p) }, p))))),
          h("div.level-links", null, h("span.muted.small", null, "Practise:"),
            lv.scenarios.map((id) => h("button.chip", { type: "button", onclick: () => practise(id) }, scenarioTitle[id])),
            h("button.chip", { type: "button", onclick: () => { location.hash = "quiz"; $("#quiz-level").value = lv.id; renderQuiz(); } }, lv.id in scores ? `Quiz ${scores[lv.id]}%` : "Quiz"))))));
    }
    const stages = [...new Set(Q.levels.map((l) => l.stage))];
    $("#stages").replaceChildren(...stages.map((st, i) => {
      const lvls = Q.levels.filter((l) => l.stage === st);
      const n = lvls.filter((l) => done.has(l.id)).length;
      const ring = h("span.ring", { "aria-hidden": "true" });
      ring.style.setProperty("--p", Math.round(n / lvls.length * 100));
      return h("a.stage-card" + (n === lvls.length ? ".complete" : ""), {
        role: "listitem", href: "#stage-" + st.toLowerCase(), onclick: (e) => { e.preventDefault(); scrollToEl(document.getElementById("stage-" + st.toLowerCase())); }
      }, ring, h("span.stage-num", null, `Stage ${i + 1}`), h("strong", null, st), h("span.muted", null, `${n} of ${lvls.length} levels`));
    }));
    $("#bar-fill").style.width = (done.size / Q.levels.length * 100) + "%";
    $("#bar").setAttribute("aria-valuenow", String(done.size));
    $("#bar-text").textContent = `${done.size} of ${Q.levels.length} levels complete`;
  }

  // --- run flow ---------------------------------------------------------------------

  let flowTimer = null;
  function selectFlow(i) {
    document.querySelectorAll("#flow .step").forEach((el, j) => {
      el.classList.toggle("on", j === i);
      el.classList.toggle("past", j < i);
      el.querySelector("button").setAttribute("aria-pressed", String(j === i));
    });
    const step = Q.flow[i];
    $("#flow-detail").replaceChildren(h("p.tag", null, `Step ${i + 1} of ${Q.flow.length} · ${step.role}`), h("h3", null, step.name), h("p", null, ...rich(step.text)), h("pre", null, h("code", null, step.try)));
  }
  function stopFlow() { clearInterval(flowTimer); flowTimer = null; $("#flow-play").textContent = "Play the flow"; }
  function playFlow() {
    if (flowTimer) return stopFlow();
    let i = 0;
    selectFlow(i);
    $("#flow-play").textContent = "Pause";
    flowTimer = setInterval(() => { if (++i >= Q.flow.length) return stopFlow(); selectFlow(i); }, 2600);
  }
  function renderFlow() {
    $("#flow").replaceChildren(...Q.flow.map((step, i) => h("li.step", null, h("button", { type: "button", "aria-pressed": "false", onclick: () => { stopFlow(); selectFlow(i); } },
      h("span.dot", { "aria-hidden": "true" }, String(i + 1)), h("span.step-name", null, step.name), h("span.step-role", null, step.role)))));
    $("#flow-play").addEventListener("click", playFlow);
    selectFlow(0);
  }

  // --- quiz -----------------------------------------------------------------------

  const EXAM_SIZE = 20;
  const shuffle = (list) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const questionsFor = (id) => (BANK[id] || []).map((item) => ({ ...item, level: id }));
  function renderQuiz() {
    const mode = $("#quiz-level").value;
    const exam = mode === "exam";
    const items = exam ? shuffle(Q.levels.flatMap((l) => questionsFor(l.id))).slice(0, EXAM_SIZE) : questionsFor(mode);
    const out = $("#quiz-list");
    out.replaceChildren();
    let answered = 0;
    let correct = 0;
    const score = h("div.score", { "aria-live": "polite" });
    const fill = h("span.fill");
    const update = () => {
      score.replaceChildren(h("span", null, h("strong", null, String(correct)), ` correct of ${answered} answered · ${items.length} questions`),
        h("span.meter", { role: "progressbar", "aria-label": "Answered", "aria-valuemin": "0", "aria-valuemax": String(items.length), "aria-valuenow": String(answered) }, fill));
      fill.style.width = (answered / items.length * 100) + "%";
      if (answered < items.length) return;
      const pct = Math.round(correct / items.length * 100);
      if (!exam) { const all = store.get("quiz", {}); all[mode] = Math.max(all[mode] || 0, pct); store.set("quiz", all); window.AQEngage.active(); renderPath(); }
      score.append(h("p.result", null, h("strong", null, `${pct}%. `), pct === 100 ? "Perfect score." : pct >= 75 ? "Strong. Review the explanations you missed." : "Read the explanations, practise the level's scenarios, and try again.",
        " ", h("button.linkish", { type: "button", onclick: renderQuiz }, exam ? "New exam" : "Try again")));
    };
    items.forEach((item, qi) => {
      const fb = h("p.feedback", { "aria-live": "polite" });
      const opts = h("div.options", { role: "group", "aria-label": `Question ${qi + 1}` });
      shuffle(item.options.map((text, index) => ({ text, index }))).forEach((opt) => {
        opts.append(h("button.opt", {
          type: "button", "data-right": opt.index === item.answer ? "1" : null,
          onclick: (e) => {
            const right = opt.index === item.answer;
            opts.querySelectorAll("button").forEach((b) => { b.disabled = true; if (b.dataset.right) b.classList.add("right"); });
            if (!right) e.currentTarget.classList.add("wrong");
            fb.replaceChildren(h("strong", null, right ? "Correct. " : "Not quite. "), ...rich(item.why));
            fb.className = "feedback " + (right ? "ok" : "bad");
            answered++;
            if (right) correct++;
            update();
          }
        }, ...rich(opt.text)));
      });
      const from = exam ? Q.levels.find((l) => l.id === item.level) : null;
      out.append(h("div.card.question", null, from ? h("p.tag", null, `Level ${from.id} · ${from.topic}`) : null, h("h3", null, `${qi + 1}. `, ...rich(item.q)), opts, fb));
    });
    out.prepend(score);
    update();
  }

  // --- Playbook X-ray ------------------------------------------------------------------

  const narrow = () => matchMedia("(max-width: 860px)").matches;
  function placeNote(li) {
    const note = $("#xray-note");
    if (li && narrow()) {
      const slot = $("#xray-lines .note-slot") || h("li.note-slot");
      li.after(slot);
      slot.append(note);
    } else if (note.parentElement !== $("#xray-view")) {
      $("#xray-view").append(note);
      const slot = $("#xray-lines .note-slot");
      if (slot) slot.remove();
    }
  }
  let pasted = null;
  function showXray() {
    $("#xray-edit").hidden = !!pasted;
    $("#xray-result").hidden = !pasted;
    $("#xray-view").hidden = !pasted;
    const lines = $("#xray-lines");
    placeNote(null);
    lines.replaceChildren();
    if (!pasted) return;
    pasted.lines.forEach(({ line, note, level, warns }, i) => {
      if (!note) { lines.append(h("li", null, h("span.line.blank", null, line || " "))); return; }
      const flag = warns.length ? ".warn" : level === "unknown" ? ".unknown" : "";
      lines.append(h("li", null, h("button.line" + flag, {
        type: "button",
        onclick: (e) => {
          lines.querySelectorAll(".line").forEach((b) => b.classList.remove("on"));
          e.currentTarget.classList.add("on");
          placeNote(e.currentTarget.parentElement);
          $("#xray-note").replaceChildren(h("pre", null, h("code", null, line.trim())), h("p", null, ...rich(note)), ...warns.map((w) => h("p.xray-warn", null, ...rich(w))), h("p.muted", null, `Line ${i + 1} of ${pasted.lines.length}`));
        }
      }, line)));
    });
    const rows = pasted.lines;
    const warned = rows.filter((r) => r.warns.length).length;
    const unknown = rows.filter((r) => r.level === "unknown").length;
    $("#xray-summary").textContent = [`${rows.filter((r) => r.note).length} lines explained`, warned && `${warned} worth a second look`, unknown && `${unknown} not in the dictionary`].filter(Boolean).join(" · ");
    $("#xray-review").replaceChildren(...(pasted.review.length ? [h("details.xray-missing", { open: true }, h("summary", null, `${pasted.review.length} thing${pasted.review.length === 1 ? "" : "s"} to check in the whole file`), h("ul.xray-review", null, pasted.review.map((n) => h("li", null, ...rich(n)))))] : []));
    $("#xray-note").replaceChildren(h("p.muted", null, "Select any line to see what it does."));
    const first = $("#xray-lines .line.warn") || $("#xray-lines button.line");
    if (first && !narrow()) first.click();
  }
  function explainPasted() {
    const text = $("#xray-input").value;
    const error = $("#xray-error");
    const fail = (msg) => { error.textContent = msg; error.hidden = false; };
    if (!text.trim()) return fail("Paste a playbook first, or choose Load an example.");
    const res = window.AQXray.explain(text);
    if (res.error) return fail(res.error);
    error.hidden = true;
    pasted = res;
    showXray();
    scrollToEl($("#xray-paste"));
  }
  const editPasted = () => { pasted = null; showXray(); $("#xray-input").focus(); };
  const clearPasted = () => { $("#xray-input").value = ""; $("#xray-error").hidden = true; editPasted(); };

  // --- troubleshooting reference -----------------------------------------------------------

  const search = (q) => window.AQSearch(Q.doctor, q);

  function renderDoctorList() {
    const index = new Map(Q.doctor.map((d, i) => [d.id, i]));
    $("#doctor-list").replaceChildren(...Q.doctorGroups.map(([name, ids]) => h("div.doctor-group", null,
      h("div.doctor-group-name", null, name, h("span.count", null, String(ids.length))),
      h("div.doctor-group-items", null, ids.map((id) => h("button.chip", { type: "button", "data-id": id, "aria-pressed": "false", onclick: () => { location.hash = "fix/" + id; } }, Q.doctor[index.get(id)].title))))));
  }
  function renderHits() {
    const q = $("#doctor-q").value;
    const hits = search(q);
    $("#doctor-hits").replaceChildren(...(!q.trim() ? [] : hits.length
      ? [h("p.muted.small", null, `${hits.length} closest match${hits.length === 1 ? "" : "es"}`), h("ul.hit-list", null, hits.map((i) => h("li", null, h("button", { type: "button", onclick: () => { location.hash = "fix/" + Q.doctor[i].id; } }, h("strong", null, Q.doctor[i].title), h("span", null, Q.doctor[i].symptom)))))]
      : [h("p.muted", null, "No entry matches. Paste the msg part of the error, or try a word such as unreachable, sudo, vault, handler or undefined.")]));
  }
  function renderDoctor(i) {
    const d = Q.doctor[i];
    document.querySelectorAll("#doctor-list button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === d.id)));
    const lv = Q.levels.find((l) => l.id === d.level);
    $("#doctor-out").replaceChildren(h("article.card.answer", { id: "fix-" + d.id },
      h("div.answer-head", null, h("h3", null, d.title), copyLink("fix/" + d.id)),
      h("p", null, d.symptom),
      h("h4", null, "Error"), h("pre", null, h("code", null, d.error)),
      h("h4", null, "Why it happens"), h("ul", null, d.causes.map((c) => h("li", null, ...rich(c)))),
      h("h4", null, "Confirm the cause"), h("pre", null, h("code", null, d.confirm.join("\n"))),
      h("h4", null, "Fix"), h("ol", null, d.fix.map((c) => h("li", null, ...rich(c)))),
      h("h4", null, "Prevent it"), h("ul", null, d.prevent.map((c) => h("li", null, ...rich(c)))),
      // Fixing is the way in; the point is to learn it, so every answer ends in practice.
      h("div.learn-it", null,
        h("h4", null, "Now learn it"),
        h("p", null, "Break this yourself in a safe playground and fix it. Doing it once is what makes you recognise it next time."),
        h("div.practise", null, h("span.muted.small", null, "Practise:"), d.scenarios.map((id) => h("button.chip", { type: "button", onclick: () => practise(id) }, scenarioTitle[id]))),
        lv ? h("p.note", null, "Then the level that teaches it: ", h("a", { href: "#level-" + lv.id, onclick: (e) => { e.preventDefault(); location.hash = "path"; setTimeout(() => { const el = document.getElementById("level-" + lv.id); el.open = true; scrollToEl(el); }); } }, `Level ${lv.id} · ${lv.title}`)) : null)));
    requestAnimationFrame(() => scrollToEl($("#doctor-out")));
  }

  // --- cheat sheet -----------------------------------------------------------------

  const copyButton = (text) => h("button.copy", {
    type: "button", "aria-label": "Copy command",
    onclick: async (e) => { const b = e.currentTarget; try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch { b.textContent = "Select it"; } setTimeout(() => { b.textContent = "Copy"; }, 1200); }
  }, "Copy");
  const FILL = [["host", "Host", "web-01"], ["group", "Group", "web"], ["playbook", "Playbook", "site.yml"], ["var", "Variable", "app_version"], ["tag", "Tag", "deploy"], ["role", "Role", "nginx"], ["file", "File", "group_vars/all/vault.yml"], ["ip", "Address", "10.0.1.11"]];
  const fills = store.get("fill", {});
  function renderFill() {
    $("#cheat-fill").replaceChildren(...FILL.map(([key, label, example]) => h("label.fill", null, label, h("input", {
      type: "text", value: fills[key] || "", placeholder: example, spellcheck: "false", autocapitalize: "off",
      oninput: (e) => { const v = e.target.value.trim().replace(/[^\w.:/@*-]/g, ""); if (v) fills[key] = v; else delete fills[key]; store.set("fill", fills); renderCheats(); }
    }))));
  }
  function renderCheats() {
    const q = $("#cheat-q").value.trim().toLowerCase();
    const out = $("#cheat-out");
    out.replaceChildren();
    const groups = new Map();
    for (const [cmd, what, group, where] of Q.cheats) {
      if (q && !(cmd + " " + what + " " + group).toLowerCase().includes(q)) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push([cmd, what, where]);
    }
    if (!groups.size) { out.append(h("p.muted", null, "No match. Try a word such as vault, limit, facts or galaxy.")); return; }
    for (const [group, rows] of groups) {
      out.append(h("h3.group", null, group), h("ul.cheats", null, rows.map(([cmd, what, where]) => {
        const parts = cmd.split(/(<[a-z-]+>)/).filter(Boolean).map((p) => { const m = /^<([a-z-]+)>$/.exec(p); return !m ? { text: p } : fills[m[1]] ? { text: fills[m[1]], filled: true } : { text: p, hole: true }; });
        const full = parts.map((p) => p.text).join("");
        return h("li", null, h("div", null, h("code", null, parts.map((p) => (p.filled ? h("span.filled", null, p.text) : p.hole ? h("span.hole", null, p.text) : p.text))), h("span.muted", null, what)),
          h("div.cheat-actions", null, where ? h("button.copy", { type: "button", title: where === "any" ? "Run it in the playground" : `Run it in the scenario "${scenarioTitle[where]}"`, onclick: () => { history.replaceState(null, "", "#path"); show(); window.AQPlayground.prefill(cmd, where); } }, "Try")
            : h("a.copy.lab", { href: Q.repo + "#quick-start", title: "Needs a real machine: run it in the course lab" }, "Lab"), copyButton(full)));
      })));
    }
  }

  // --- page guides -------------------------------------------------------------------

  const GUIDES_CLOSED = ["playground", "path", "doctor", "xray"];
  function renderGuides() {
    const state = store.get("guides", {});
    document.querySelectorAll(".guide-slot").forEach((slot) => {
      const key = slot.dataset.guide;
      const g = Q.guides[key];
      const box = h("details.guide", { open: state[key] ?? !GUIDES_CLOSED.includes(key) }, h("summary", null, "How to use this"),
        h("div.guide-body", null, h("p", null, ...rich(g.what)), h("div.guide-cols", null,
          h("div", null, h("h3", null, "How to use it"), h("ol", null, g.steps.map((t) => h("li", null, ...rich(t))))),
          h("div", null, h("h3", null, "What it is for"), h("ul", null, g.uses.map((t) => h("li", null, ...rich(t)))), h("h3", null, "Tips"), h("ul", null, g.tips.map((t) => h("li", null, ...rich(t))))))));
      let shown = box.open;
      box.addEventListener("toggle", () => { if (box.open === shown) return; shown = box.open; store.set("guides", { ...store.get("guides", {}), [key]: shown }); });
      slot.replaceChildren(box);
    });
  }

  // --- command palette (Ctrl+K, Cmd+K or /) ------------------------------------------------

  const palette = $("#palette");
  const paletteInput = $("#palette-input");
  const paletteList = $("#palette-list");
  let items = [];
  let active = 0;
  const go = (hash, then) => () => { location.hash = hash; show(); if (then) then(); };
  const ACTIONS = [
    { label: "Playground: fix a broken fleet", kind: "Section", run: go("path", () => scrollToEl($(".playground"))) },
    { label: "What happens when you run ansible-playbook", kind: "Section", run: go("path", () => scrollToEl($(".flow-block"))) },
    { label: "Your path", kind: "Section", run: go("path", () => scrollToEl($("#path-title"))) },
    { label: "Exam: random questions from every level", kind: "Quiz", run: go("quiz", () => { $("#quiz-level").value = "exam"; renderQuiz(); }) },
    { label: "Playbook X-ray", kind: "Section", run: go("xray") },
    { label: "Fix: troubleshoot an error", kind: "Section", run: go("doctor", () => $("#doctor-q").focus()) },
    { label: "Cheat sheet", kind: "Section", run: go("cheats", () => $("#cheat-q").focus()) },
    { label: "How a play runs", kind: "Section", run: go("arch") },
    ...Q.levels.map((lv) => ({ label: `${lv.id} · ${lv.title}`, hint: lv.topic, kind: "Level", run: go("path", () => { const el = document.getElementById("level-" + lv.id); el.open = true; scrollToEl(el); }) })),
    ...Q.levels.map((lv) => ({ label: `Quiz: ${lv.id} · ${lv.topic}`, kind: "Quiz", run: go("quiz", () => { $("#quiz-level").value = lv.id; renderQuiz(); }) })),
    ...SCN.map((s) => ({ label: `Playground: ${s.title}`, hint: s.group + " " + s.error, kind: "Practice", run: () => { location.hash = "play/" + s.id; } })),
    ...Q.doctor.map((d) => ({ label: `Troubleshoot: ${d.title}`, hint: d.error, kind: "Reference", run: () => { location.hash = "fix/" + d.id; } }))
  ];
  function renderPalette() {
    const ws = paletteInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    items = ACTIONS.filter((a) => { const t = `${a.label} ${a.hint || ""} ${a.kind}`.toLowerCase(); return ws.every((w) => t.includes(w)); }).slice(0, 8);
    active = Math.min(active, Math.max(0, items.length - 1));
    paletteList.replaceChildren(...items.map((a, i) => h("li", { role: "option", id: "pal-" + i, "aria-selected": String(i === active), onclick: () => choose(i), onmousemove: () => { if (active !== i) { active = i; renderPalette(); } } },
      h("span.pal-label", null, a.label), h("span.pal-kind", null, a.kind))));
    if (!items.length) paletteList.append(h("li.muted", null, "Nothing matches. Try a word such as vault, handler or sudo."));
    paletteInput.setAttribute("aria-activedescendant", items.length ? "pal-" + active : "");
  }
  function openPalette() { if (palette.open) return; paletteInput.value = ""; active = 0; renderPalette(); palette.showModal(); paletteInput.focus(); }
  function choose(i) { const a = items[i]; if (!a) return; palette.close(); a.run(); }
  paletteInput.addEventListener("input", () => { active = 0; renderPalette(); });
  paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      renderPalette();
      const el = document.getElementById("pal-" + active);
      if (el) el.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { e.preventDefault(); choose(active); }
  });
  palette.addEventListener("click", (e) => { if (e.target === palette) palette.close(); });
  $("#palette-open").addEventListener("click", openPalette);
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $("#palette-key").textContent = "⌘K";
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); }
    else if (e.key === "/" && !typing) { e.preventDefault(); openPalette(); }
  });

  // --- init -------------------------------------------------------------------------

  $("#quiz-level").append(h("option", { value: "exam" }, `Exam: ${EXAM_SIZE} random questions from every level`));
  for (const lv of Q.levels) $("#quiz-level").append(h("option", { value: lv.id }, `${lv.id} · ${lv.topic} (${questionsFor(lv.id).length} questions)`));
  $("#quiz-level").value = "00";
  $("#quiz-level").addEventListener("change", renderQuiz);
  $("#quiz-again").addEventListener("click", () => { renderQuiz(); $("#quiz-list").scrollIntoView({ block: "start" }); });
  $("#xray-pick").append(
    h("button", { type: "button", role: "tab", "aria-selected": "true", onclick: (e) => { selectSeg(e); editPasted(); } }, "Paste your playbook"),
    h("button", { type: "button", role: "tab", "aria-selected": "false", onclick: (e) => { selectSeg(e); $("#xray-input").value = Q.xrayExample; explainPasted(); } }, "Example with problems"));
  function selectSeg(e) { document.querySelectorAll("#xray-pick button").forEach((b) => b.setAttribute("aria-selected", String(b === e.currentTarget))); }
  $("#xray-go").addEventListener("click", explainPasted);
  $("#xray-edit-btn").addEventListener("click", editPasted);
  for (const id of ["#xray-clear", "#xray-clear-2"]) $(id).addEventListener("click", clearPasted);
  $("#xray-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) explainPasted(); });
  $("#xray-example").addEventListener("click", () => { $("#xray-input").value = Q.xrayExample; explainPasted(); });
  $("#doctor-q").addEventListener("input", renderHits);
  // The home page's "Something broken?" box hands the pasted error to Troubleshoot.
  const doorGo = go("doctor", () => { $("#doctor-q").value = $("#door-q").value; renderHits(); $("#doctor-q").focus(); });
  $("#door-go").addEventListener("click", doorGo);
  $("#door-q").addEventListener("keydown", (e) => { if (e.key === "Enter") doorGo(); });
  $("#cheat-q").addEventListener("input", renderCheats);
  $("#forget").addEventListener("click", forgetEverything);
  $("#cheat-fill-box").open = matchMedia("(min-width: 721px)").matches || Object.keys(fills).length > 0;

  // Shared with playground.js and architecture.js, which load after this script.
  window.AQUI = { h, rich, practise, copyLink, store };

  signature();
  heroData();
  renderGuides();
  renderFlow();
  renderQuiz();
  renderDoctorList();
  renderFill();
  renderCheats();
  show();
  // The path's lab check comes from engage.js, and deep links into the playground need it loaded first.
  window.addEventListener("DOMContentLoaded", () => { renderPath(); if (/^#play\//.test(location.hash)) show(); });
})();
