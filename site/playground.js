// The playground's page: a terminal over the simulator in sim.js, an editor
// for the project's files, and a live view of the fleet. Nothing here talks
// to a real machine; the simulator only renders what it is told.
"use strict";

(function () {
  const { h, copyLink, store } = window.AQUI;
  const Q = window.QUEST;
  const { Sim } = window.AQSim;
  const { SCENARIOS, GROUPS } = window.AQScenarios;
  const $ = (sel) => document.querySelector(sel);
  const out = $("#pg-out");
  const input = $("#pg-input");
  const editor = $("#pg-editor");
  const editorText = $("#pg-editor-text");
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  const HELP = [
    "Commands this playground understands:",
    "  ansible <pattern> -m <module> -a '<args>' [-b] [-K] [-e k=v] [-o]",
    "  ansible-playbook <playbook> [-i inv] [-l limit] [-t tags] [--skip-tags] [-e k=v] [-C] [-D] [-v] [-K] [-J]",
    "      [--syntax-check] [--list-hosts] [--list-tasks] [--list-tags] [--vault-password-file f] [-f forks]",
    "  ansible-inventory --graph | --list | --host <host>",
    "  ansible-vault view | edit | encrypt | decrypt | create | encrypt_string",
    "  ansible-galaxy collection install|list, ansible-galaxy install -r requirements.yml, ansible-galaxy role init",
    "  ansible-doc <module>, ansible-doc -l, ansible-config dump --only-changed, ansible --version",
    "  ssh [-i key] user@host [command], ssh-keygen -R <host>, ssh-keyscan <host>",
    "  ls, tree, cat [-n], edit <file>, sed -i 's/a/b/' <file>, mv, cp, rm, mkdir, echo ... >> <file>",
    "  && chains commands; | pipes into grep, head, tail or wc -l.",
    "  hint, reset, next, clear, help. Up and down arrows recall commands; Tab completes."
  ];

  let scenario = null;
  let sim = null;
  let solved = false;
  let hintLevel = 0;
  let pending = null; // a prompt waiting for an answer
  let editing = null;
  let lastSeen = {};
  const history = [];
  let historyPos = 0;

  const solvedSet = () => new Set(store.get("solved", []));
  const markSolved = (id) => store.set("solved", [...new Set([...store.get("solved", []), id])]);

  function print(text, cls) {
    for (const line of String(text).split("\n")) {
      const el = document.createElement("div");
      el.className = "pg-line" + (cls ? " " + cls : "") + (/^(PLAY|TASK|RUNNING HANDLER|PLAY RECAP|NO MORE HOSTS LEFT)\b.* \*{3,}$/.test(line) ? " banner" : /^\S+ +: ok=\d/.test(line) ? " row" : "");
      el.textContent = line;
      out.append(el);
    }
    out.scrollTop = out.scrollHeight;
  }

  function renderPicker() {
    const done = solvedSet();
    $("#pg-scenarios").replaceChildren(...GROUPS.map(([group, ids]) => {
      const n = ids.filter((id) => done.has(id)).length;
      return h("div.pg-group", null,
        h("span.pg-group-name", null, group, h("span.count" + (n === ids.length ? ".done" : ""), null, `${n}/${ids.length}`)),
        h("div.pg-group-items", null, ids.map((id) => {
          const s = SCENARIOS.find((x) => x.id === id);
          return h("button.pg-scn", { type: "button", "aria-pressed": String(s === scenario), "data-id": id, title: done.has(id) ? `${s.title} (solved)` : s.title, onclick: () => open(id) },
            done.has(id) ? h("span.pg-scn-done", { "aria-hidden": "true" }, "✓") : null, s.title);
        })));
    }));
  }
  // Clicking a scenario updates the address, so the link can be shared.
  function open(id) {
    if (location.hash === "#play/" + id) load(id);
    else location.hash = "play/" + id;
  }

  function renderStory() {
    const lv = Q.levels.find((l) => l.id === scenario.level);
    $("#pg-story").replaceChildren(
      h("div.pg-story-head", null, h("h3", null, scenario.title), copyLink("play/" + scenario.id)),
      h("p", null, scenario.story),
      h("p.muted.small", null, `${scenario.group} · Level ${lv.id}: ${lv.title}`));
  }

  // The fleet: one card per host with its result in the last run. Big
  // fleets are summed up instead.
  function renderMap() {
    const run = [...sim.runs].reverse().find((r) => !r.list && !r.syntax && Object.keys(r.stats).length);
    const state = (name) => {
      const s = run && run.stats[name];
      if (!s) return ["", "not in the last run"];
      if (s.unreachable) return ["unreachable", "unreachable"];
      if (s.failed) return ["failed", `failed=${s.failed} ok=${s.ok}`];
      if (s.changed) return ["changed", `ok=${s.ok} changed=${s.changed}`];
      return ["ok", `ok=${s.ok} changed=0`];
    };
    const hosts = Object.values(sim.hosts);
    const icon = { ok: "✓", changed: "~", failed: "!", unreachable: "×", "": "·" };
    let cards;
    if (hosts.length > 12) {
      const tally = { ok: 0, changed: 0, failed: 0, unreachable: 0, "": 0 };
      for (const x of hosts) tally[state(x.name)[0]]++;
      cards = [h("div.pg-host", { role: "group" }, h("b", null, `${hosts[0].name} … ${hosts[hosts.length - 1].name}`), h("span", null, `${hosts.length} hosts, ${hosts[0].os.label}`)),
        h("div.pg-host" + (tally.failed || tally.unreachable ? ".failed" : run ? ".ok" : ""), { role: "group" }, h("b", null, "Last run"),
          h("span", null, run ? `ok ${tally.ok + tally.changed}, failed ${tally.failed + tally.unreachable}${run.time ? `, ${Math.floor(run.time / 60)}m ${run.time % 60}s` : ""}` : "not run yet"))];
    } else {
      cards = hosts.map((x) => {
        const [cls, text] = state(x.name);
        const changedNow = lastSeen[x.name] !== undefined && lastSeen[x.name] !== text && run;
        lastSeen[x.name] = text;
        const card = h("button.pg-host" + (cls ? "." + cls : "") + (changedNow && !reduceMotion() ? ".flash" : ""), { type: "button", title: `${x.name} (${x.ip}): ${text}. Click to use the name.` },
          h("b", null, h("i", { "aria-hidden": "true" }, icon[cls]), x.name), h("span", null, `${x.os.label} · ${x.ip}`), h("span", null, text));
        card.addEventListener("click", () => { const v = input.value; input.value = (v && !v.endsWith(" ") ? v + " " : v) + x.name; input.focus(); });
        return card;
      });
    }
    $("#pg-map").replaceChildren(...cards);
    const c = scenario.check(sim);
    const box = $("#pg-check");
    box.className = "pg-check " + (c.ok ? "ok" : "bad");
    box.replaceChildren(h("strong", null, c.label), h("span.state", null, c.text));
  }

  function renderFiles() {
    $("#pg-files").replaceChildren(...sim.projectFiles().map((f) => h("li", null, h("button", { type: "button", title: `Open ${f} in the editor`, onclick: () => run("edit " + f) }, f))));
  }

  function renderTries() {
    $("#pg-try").replaceChildren(h("span.muted.small", null, "Try"), ...[...scenario.tries, "hint", "reset"].map((cmd) =>
      h("button.chip", { type: "button", title: cmd, onclick: () => { run(cmd); input.focus(); } }, cmd)));
  }

  function load(id) {
    scenario = SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];
    sim = new Sim(scenario);
    solved = false;
    hintLevel = 0;
    pending = null;
    lastSeen = {};
    closeEditor();
    setPrompt();
    out.replaceChildren();
    print(`On call for the platform team. ${scenario.story}`, "dim");
    print("Find out why with ansible and ansible-playbook, then fix it. Type 'help' for commands, 'hint' if stuck.", "dim");
    print("");
    $("#pg-goal").textContent = "Goal: " + scenario.goal;
    $("#pg-goal").className = "pg-goal";
    renderPicker();
    renderStory();
    renderTries();
    renderMap();
    renderFiles();
    const picker = $("#pg-scenarios");
    const cur = picker.querySelector('[aria-pressed="true"]');
    if (cur && picker.scrollWidth > picker.clientWidth) picker.scrollLeft = cur.offsetLeft - 48;
  }

  function check() {
    if (solved || !scenario.won(sim)) return;
    solved = true;
    markSolved(scenario.id);
    renderPicker();
    const b = $(`.pg-scn[data-id="${scenario.id}"]`);
    if (b) b.classList.add("just-solved");
    $("#pg-goal").textContent = "Fixed. " + scenario.goal;
    $("#pg-goal").className = "pg-goal done";
    const lv = Q.levels.find((l) => l.id === scenario.level);
    print("");
    print("✓ Fixed. " + scenario.lesson, "won");
    print(`  Read more: Level ${lv.id} · ${lv.title}.`, "dim");
    const next = SCENARIOS.find((s) => !solvedSet().has(s.id));
    print(next ? `  Next: ${next.title}. Pick it above, or type 'next'.` : "  You have solved every scenario. Try the labs on a real machine.", "dim");
  }

  function setPrompt(p) {
    $("#pg-prompt").textContent = p ? p.text.trim() : "$";
    input.type = p && p.secret ? "password" : "text";
    input.placeholder = p ? "" : "ansible-playbook site.yml";
    input.setAttribute("aria-label", p ? p.text.trim() : "Type a command");
  }

  function show(result) {
    for (const [text, cls] of result.out) print(text, cls);
    pending = result.prompt || null;
    setPrompt(pending);
    if (result.edit) openEditor(result.edit);
    renderMap();
    renderFiles();
    check();
  }

  function run(raw) {
    if (pending) {
      const p = pending;
      print(p.text + (p.secret ? "" : raw), "dim");
      let res;
      try { res = p.answer(raw); } catch { res = { out: [["(the playground could not finish that; type 'reset' to start the scenario again)", "warn"]] }; }
      return show(res);
    }
    const line = raw.trim();
    print("$ " + line, "cmd");
    if (!line) return;
    if (line === "help") return HELP.forEach((x) => print(x, "dim"));
    if (line === "clear") return out.replaceChildren();
    if (line === "reset") return load(scenario.id);
    if (line === "next") {
      const next = SCENARIOS.find((s) => !solvedSet().has(s.id) && s !== scenario) || SCENARIOS[(SCENARIOS.indexOf(scenario) + 1) % SCENARIOS.length];
      return open(next.id);
    }
    if (line === "hint") return print(`Hint ${Math.min(hintLevel, 2) + 1} of 3: ` + scenario.hints[Math.min(hintLevel++, 2)].replace(/`/g, ""), "dim");
    if (line === "history") return history.forEach((x, i) => print(`${String(i + 1).padStart(5)}  ${x}`));
    let res;
    try { res = sim.exec(line); } catch { res = { out: [["(the playground could not run that command; check its quoting, or type 'help')", "warn"]] }; }
    show(res);
  }

  // --- the editor ---------------------------------------------------------------------

  function openEditor(e) {
    editing = e;
    $("#pg-editor-name").textContent = e.path + (e.vault ? " (decrypted; saved encrypted)" : "");
    editorText.value = e.text;
    editor.hidden = false;
    editorText.focus();
    editorText.setSelectionRange(0, 0);
    editorText.scrollTop = 0;
  }
  function closeEditor() { editing = null; editor.hidden = true; }
  function saveEditor() {
    if (!editing) return;
    let text = editorText.value;
    if (text && !text.endsWith("\n")) text += "\n";
    sim.save(editing.path, editing.vault ? window.AQLang.vaultEncrypt(text, editing.vault) + "\n" : text);
    print(`# saved ${editing.path}`, "dim");
    closeEditor();
    renderFiles();
    renderMap();
    check();
    input.focus();
  }
  $("#pg-editor-save").addEventListener("click", saveEditor);
  $("#pg-editor-cancel").addEventListener("click", () => { closeEditor(); input.focus(); });
  editorText.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveEditor(); }
    else if (e.key === "Escape") { e.preventDefault(); closeEditor(); input.focus(); }
    else if (e.key === "Tab" && !e.shiftKey) {
      // Two spaces, as YAML wants; Shift+Tab still leaves the field.
      e.preventDefault();
      const s = editorText.selectionStart;
      editorText.setRangeText("  ", s, editorText.selectionEnd, "end");
    }
  });

  // --- input ----------------------------------------------------------------------

  const WORDS = ["ansible", "ansible-playbook", "ansible-inventory", "ansible-vault", "ansible-galaxy", "ansible-doc", "ansible-config", "--graph", "--list", "--host",
    "--syntax-check", "--check", "--diff", "--limit", "--tags", "--skip-tags", "--list-hosts", "--list-tasks", "--list-tags", "--vault-password-file", "--ask-vault-pass",
    "--ask-become-pass", "--start-at-task", "--force-handlers", "collection", "install", "encrypt_string", "encrypt", "decrypt", "view", "edit", "ping", "setup", "shell",
    "command", "raw", "service", "debug", "stat", "~/.vault_pass.txt", "requirements.yml", "known_hosts", "ssh-keygen", "ssh-keyscan"];
  function complete() {
    const v = input.value;
    const start = v.lastIndexOf(" ") + 1;
    const stem = v.slice(start);
    const names = [...WORDS, ...Object.keys(sim.hosts), ...sim.projectFiles()];
    const hits = [...new Set(names)].filter((n) => n.startsWith(stem) && n !== stem);
    if (hits.length === 1) input.value = v.slice(0, start) + hits[0] + " ";
    else if (hits.length > 1) {
      let common = hits[0];
      for (const x of hits) while (!x.startsWith(common)) common = common.slice(0, -1);
      if (common.length > stem.length) input.value = v.slice(0, start) + common;
      else print(hits.slice(0, 30).join("   "), "dim");
    }
  }

  $("#pg-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value;
    if (value.trim() && !pending) { history.push(value); historyPos = history.length; }
    input.value = "";
    run(value);
  });
  input.addEventListener("keydown", (e) => {
    if (pending) return;
    if (e.key === "ArrowUp" && historyPos > 0) { historyPos--; input.value = history[historyPos]; e.preventDefault(); }
    if (e.key === "ArrowDown") { historyPos = Math.min(history.length, historyPos + 1); input.value = history[historyPos] || ""; e.preventDefault(); }
    if (e.key === "Tab" && input.value.trim()) { e.preventDefault(); complete(); }
  });
  out.addEventListener("click", () => { if (!window.getSelection().toString()) input.focus(); });

  const reveal = () => { $("#pg-term").scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" }); input.focus({ preventScroll: true }); };
  window.AQPlayground = {
    load: (id) => { load(id); reveal(); },
    // From the cheat sheet: open the scenario a command needs, fill its
    // blanks with that scenario's names, and run it.
    prefill: (cmd, where) => {
      if (where && where !== "any" && where !== scenario.id) { history.replaceState(null, "", "#play/" + where); load(where); }
      reveal();
      const names = { ...Q.fills.any, ...(Q.fills[where !== "any" && where ? where : scenario.id] || {}) };
      const full = cmd.replace(/<([a-z-]+)>/g, (m, k) => names[k] || m);
      if (/<[a-z-]+>/.test(full)) input.value = full;
      else setTimeout(() => run(full));
    }
  };
  if (!/^#play\//.test(location.hash)) load(SCENARIOS[0].id);
  else load(location.hash.split("/")[1]);
})();
