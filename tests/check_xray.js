// Checks the Playbook X-ray: risky patterns are flagged, every line of the
// repository's own playbooks is explained, and nothing crashes.
// Run with: node tests/check_xray.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
require(path.join(root, "site/lang.js"));
require(path.join(root, "site/xray.js"));
global.window = global.window || {};
require(path.join(root, "site/data.js"));
const { explain } = globalThis.AQXray;

const r = explain(window.QUEST.xrayExample);
const warnsAt = (text) => r.lines.filter((l) => l.line.includes(text)).flatMap((l) => l.warns).join(" ");
assert.match(warnsAt("become: true"), /every task as root/);
assert.match(warnsAt("hosts: all"), /every host/);
assert.match(warnsAt("db_password: Winter"), /secret in plain text/);
assert.match(warnsAt("state: latest"), /Pin a version/);
assert.match(warnsAt("apt-get install"), /module does this[\s\S]*apt/);
assert.match(warnsAt("apt-get install"), /changed_when/);
assert.match(warnsAt("path: {{ app_dir }}"), /must be quoted/);
assert.match(warnsAt("mode: 755"), /decimal number 755/);
assert.match(warnsAt("set-password"), /without no_log/);
assert.match(warnsAt("curl -s"), /into a shell/);
assert.match(warnsAt("ignore_errors"), /hides failures/);
assert.ok(r.review.some((x) => /no name/.test(x)), "review: unnamed tasks");
assert.ok(r.review.some((x) => /no serial/.test(x)), "review: restarts without serial");
assert.ok(r.review.some((x) => /FQCN/.test(x)), "review: short module names");
assert.ok(r.review.some((x) => /YAML error at line 18/.test(x)), "review: the YAML error");

const good = explain("---\n- name: Web\n  hosts: web\n  tasks:\n    - name: Read version\n      ansible.builtin.command: git --version\n      changed_when: false\n      register: v\n    - name: Show\n      ansible.builtin.debug:\n        var: v.stdout\n");
assert.deepStrictEqual(good.lines.flatMap((l) => l.warns), [], "a clean playbook has no warnings");
assert.deepStrictEqual(good.review, []);
const sudo = explain("- name: s\n  ansible.builtin.template:\n    src: s.j2\n    dest: /etc/sudoers.d/x\n");
assert.match(sudo.lines[1].warns.join(" "), /visudo/);
assert.match(explain("x\n".repeat(700)).error, /600 lines/);
assert.match(explain("- name: x\n  foo.bar.baz:\n    a: 1\n").lines[1].note, /foo.bar collection/);

// Every playbook in the repository: no crash, a note for every line, and most known.
let files = 0, total = 0, unknown = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name.startsWith(".") || e.name === "site" || e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : /\.ya?ml$/.test(e.name) ? [path.join(d, e.name)] : []));
for (const f of walk(root).filter((f) => !/requirements\.yml$/.test(f))) {
  const res = explain(fs.readFileSync(f, "utf8"));
  files++;
  for (const l of res.lines) {
    if (l.level === "blank") continue;
    assert.ok(l.note, `${path.relative(root, f)}: no note for "${l.line}"`);
    total++;
    if (l.level === "unknown") { unknown++; console.log("  unknown:", path.relative(root, f), l.line.trim()); }
  }
}
const known = 1 - unknown / total;
assert.ok(files >= 9 && known > 0.95, `only ${(known * 100).toFixed(1)}% of ${total} lines explained`);
console.log(`xray ok: ${files} playbooks, ${total} lines, ${(known * 100).toFixed(1)}% explained`);
