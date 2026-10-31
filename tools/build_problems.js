// Writes site/problems.html: every troubleshooting entry as plain HTML, readable
// without JavaScript and by search engines. tests/check_site_data.js fails when
// the file is out of date. Run with: node tools/build_problems.js
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
function load() {
  global.window = {};
  for (const f of ["data", "lang", "sim", "scenarios"]) require(path.join(root, "site", f + ".js"));
  return { Q: window.TRACK, SCN: window.AQScenarios.SCENARIOS };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// `code` in the reference text becomes <code>.
const rich = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

function render({ Q, SCN }) {
  const title = Object.fromEntries(SCN.map((s) => [s.id, s.title]));
  const byId = Object.fromEntries(Q.doctor.map((d) => [d.id, d]));
  const toc = Q.doctorGroups.map(([group, ids]) => `      <h3>${esc(group)}</h3>\n      <ul class="toc">\n${ids.map((id) => `        <li><a href="#${id}">${esc(byId[id].title)}</a></li>`).join("\n")}\n      </ul>`).join("\n");
  const entries = Q.doctorGroups.flatMap(([, ids]) => ids).map((id) => {
    const d = byId[id];
    const lv = Q.levels.find((l) => l.id === d.level);
    return `    <article class="card answer" id="${d.id}">
      <h2>${esc(d.title)}</h2>
      <p>${rich(d.symptom)}</p>
      <h4>Error</h4>
      <pre><code>${esc(d.error)}</code></pre>
      <h4>Why it happens</h4>
      <ul>${d.causes.map((c) => `<li>${rich(c)}</li>`).join("")}</ul>
      <h4>Confirm the cause</h4>
      <pre><code>${esc(d.confirm.join("\n"))}</code></pre>
      <h4>Fix</h4>
      <ol>${d.fix.map((c) => `<li>${rich(c)}</li>`).join("")}</ol>
      <h4>Prevent it</h4>
      <ul>${d.prevent.map((c) => `<li>${rich(c)}</li>`).join("")}</ul>
      <p class="practise"><strong>Now learn it:</strong> break and fix it yourself in ${d.scenarios.map((s) => `<a href="index.html#play/${s}">${esc(title[s])}</a>`).join(" · ")}, then take <a href="index.html#path">Level ${lv.id} · ${esc(lv.title)}</a>. <a href="index.html#fix/${d.id}">Interactive version</a></p>
    </article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="description" content="Every common Ansible error with the exact message, its cause, how to confirm it, the fix and how to prevent it: UNREACHABLE, Missing sudo password, undefined variables, YAML errors, Vault, handlers and more.">
  <meta property="og:type" content="article">
  <meta property="og:title" content="Ansible errors and how to fix them">
  <meta property="og:description" content="${Q.doctor.length} Ansible errors explained: exact message, cause, confirm, fix, prevent.">
  <meta property="og:url" content="${Q.site}problems.html">
  <link rel="canonical" href="${Q.site}problems.html">
  <title>Ansible errors and fixes</title>
  <link rel="stylesheet" href="style.css">
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
</head>
<body class="static-page">
  <header class="top">
    <div class="wrap top-inner">
      <a class="brand" href="index.html" aria-label="DevOps Nimbus Ansible, home"><img class="mark" src="nimbus.svg" alt="" width="37" height="22"> DevOps Nimbus <span class="brand-track">Ansible</span></a>
      <nav aria-label="Sections"><a href="index.html#path">Path</a><a href="index.html#doctor">Troubleshoot</a><a href="index.html#cheats">Cheat sheet</a></nav>
    </div>
  </header>
  <main class="wrap">
    <h1>Ansible errors and how to fix them</h1>
    <p class="lede">${Q.doctor.length} errors and symptoms Ansible users meet, each with the exact message, why it happens, how to confirm the cause, the fix and how to prevent it. Then learn it for good: break and fix each one yourself in the <a href="index.html#pg-title">browser playground</a>. Generated from the same data as the <a href="index.html#doctor">interactive reference</a>.</p>
    <nav aria-label="Contents">
${toc}
    </nav>
${entries}
  </main>
  <footer class="foot">
    <div class="wrap foot-base">
      <p>© 2024–2026 Sandeep Komal Pothu and contributors. Open source under the <a href="${Q.repo}/blob/main/LICENSE">MIT License</a>.</p>
      <p class="foot-tm">Ansible® is a registered trademark of Red Hat, Inc. This project is independent and not affiliated with Red Hat.</p>
    </div>
  </footer>
</body>
</html>
`;
}

if (require.main === module) {
  fs.writeFileSync(path.join(root, "site/problems.html"), render(load()));
  console.log("wrote site/problems.html");
}
module.exports = { render, load };
