// Checks the site's data: levels point at files that exist, every quiz
// question is well formed, the troubleshooting reference is complete, and
// problems.html matches the data. Run with: node tests/check_site_data.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const { render, load } = require(path.join(root, "tools/build_problems.js"));
const { Q, SCN } = load();
require(path.join(root, "site/quiz-bank.js"));
const bank = window.TRACK_QUIZ_BANK;
const scenarioIds = new Set(SCN.map((s) => s.id));

assert.deepStrictEqual(Q.levels.map((l) => l.id), Q.levels.map((l, i) => String(i).padStart(2, "0")), "levels are numbered in order");
for (const lv of Q.levels) {
  for (const k of ["title", "topic", "stage"]) assert.ok(lv[k], `level ${lv.id}: ${k}`);
  assert.ok(lv.learn.length >= 3 && lv.lab.text && lv.lab.cmds.length, `level ${lv.id}: what you learn and a lab`);
  for (const p of lv.refs) assert.ok(fs.existsSync(path.join(root, p)), `level ${lv.id}: ${p} exists in the repository`);
  for (const id of lv.scenarios) assert.ok(scenarioIds.has(id), `level ${lv.id}: scenario ${id}`);
}
for (const s of SCN) assert.ok(Q.levels.some((l) => l.scenarios.includes(s.id)), `scenario ${s.id} is practised by some level`);

let total = 0;
for (const lv of Q.levels) {
  const items = bank[lv.id] || [];
  assert.ok(items.length >= 8, `level ${lv.id} needs at least 8 quiz questions, has ${items.length}`);
  const seen = new Set();
  for (const item of items) {
    total++;
    const where = `level ${lv.id}: "${item.q}"`;
    assert.ok(!seen.has(item.q), `${where}: duplicate`);
    seen.add(item.q);
    assert.strictEqual(new Set(item.options).size, 4, `${where}: four different options`);
    assert.ok(Number.isInteger(item.answer) && item.answer >= 0 && item.answer < 4, `${where}: answer index`);
    assert.ok(item.why.length > 20, `${where}: explanation`);
    for (const t of [item.q, item.why, ...item.options]) assert.strictEqual((t.match(/`/g) || []).length % 2, 0, `${where}: unbalanced backticks`);
  }
}

const ids = Q.doctor.map((d) => d.id);
assert.strictEqual(new Set(ids).size, ids.length, "troubleshooting ids are unique");
for (const d of Q.doctor) {
  assert.match(d.id, /^[a-z0-9-]+$/, `${d.id}: id is a stable slug`);
  for (const k of ["title", "error", "symptom"]) assert.ok(d[k], `${d.id}: ${k}`);
  for (const k of ["causes", "confirm", "fix", "prevent", "scenarios"]) assert.ok(d[k].length, `${d.id}: ${k}`);
  assert.ok(Q.levels.some((l) => l.id === d.level), `${d.id}: level`);
  for (const s of d.scenarios) assert.ok(scenarioIds.has(s), `${d.id}: scenario ${s}`);
}
assert.deepStrictEqual(Q.doctorGroups.flatMap(([, x]) => x).sort(), [...ids].sort(), "every entry is in exactly one group");
assert.ok(Q.doctor.length >= 40, "the reference covers the common errors");
// Each scenario's error appears in the reference.
for (const s of SCN) assert.ok(Q.doctor.some((d) => d.scenarios.includes(s.id)), `scenario ${s.id} has a troubleshooting entry`);

// Pasted errors find their entry: each entry's own error, and each scenario's.
require(path.join(root, "site/search.js"));
const search = (q) => window.AQSearch(Q.doctor, q, 3);
for (const [i, d] of Q.doctor.entries()) assert.ok(search(d.error).includes(i), `search: "${d.title}" is found by its own error`);
for (const s of SCN.filter((x) => /ERROR!|fatal:|\[WARNING\]|Syntax Error/.test(x.error))) assert.ok(search(s.error).some((i) => Q.doctor[i].scenarios.includes(s.id)), `search: scenario ${s.id}'s error finds its entry`);
assert.deepStrictEqual(search("   "), []);
const html = fs.readFileSync(path.join(root, "site/index.html"), "utf8");
assert.ok(html.includes(`with ${SCN.length} scenarios`), "index.html's description counts the scenarios");
for (const tag of ['name="description"', 'property="og:title"', 'property="og:description"', 'rel="canonical"']) assert.ok(html.includes(tag), `index.html has ${tag}`);
assert.ok(!/style="|\son[a-z]+="|<script>/.test(html), "no inline styles, handlers or scripts");
const robots = fs.readFileSync(path.join(root, "site/robots.txt"), "utf8");
assert.match(robots, /Sitemap: https:\/\/sandeepkomal\.github\.io\/Ansible\/sitemap\.xml/);
assert.match(fs.readFileSync(path.join(root, "site/sitemap.xml"), "utf8"), /problems\.html/);

// problems.html is generated; it must match the data.
const page = fs.readFileSync(path.join(root, "site/problems.html"), "utf8");
assert.strictEqual(page, render({ Q, SCN }), "site/problems.html is stale: run node tools/build_problems.js");
assert.ok(!/<script/.test(page), "problems.html works without JavaScript");
for (const d of Q.doctor) assert.ok(page.includes(`id="${d.id}"`), `problems.html has ${d.id}`);

console.log(`site data ok: ${Q.levels.length} levels, ${total} quiz questions, ${Q.doctor.length} troubleshooting entries, problems.html in sync`);
