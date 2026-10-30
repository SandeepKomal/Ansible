// Throws thousands of random and malformed commands, and random edits to the
// project's files, at the playground. Nothing may throw: every input must end
// in output, as a real terminal would. Run with: node tests/fuzz_playground.js [rounds]
"use strict";
const path = require("path");

for (const f of ["lang", "sim", "scenarios"]) require(path.resolve(__dirname, "../site/" + f + ".js"));
const { Sim } = globalThis.AQSim;
const { SCENARIOS } = globalThis.AQScenarios;

let seed = 20261030;
const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
const pick = (a) => a[rnd(a.length)];

const TOOLS = ["ansible", "ansible-playbook", "ansible-inventory", "ansible-vault", "ansible-galaxy", "ansible-doc", "ansible-config", "ssh", "ssh-keygen", "ssh-keyscan",
  "cat", "ls", "tree", "edit", "sed", "mv", "cp", "rm", "mkdir", "touch", "echo", "grep", "pwd", "cd", "ansible-lint", "nosuch"];
const WORDS = ["web", "all", "db", "web-01", "lb-01", "'web*'", "!web-02", "web:&db", "-m", "ping", "setup", "shell", "command", "raw", "apt", "service", "copy", "template",
  "-a", "'name=nginx state=present'", "'cat /etc/hosts'", "'uptime'", "-b", "-K", "-J", "-C", "-D", "-v", "-vvv", "-e", "x=1", "'{\"a\": [1, {\"b\": null}]}'", "@nope.yml",
  "-i", "inventory/hosts.ini", "nope.ini", "a,b,", "-l", "--limit", "-t", "--tags", "deploy", "--skip-tags", "always", "--syntax-check", "--list-tasks", "--list-hosts",
  "--list-tags", "--check", "--diff", "--vault-password-file", "~/.vault_pass.txt", "--force-handlers", "--start-at-task", "'Install nginx'", "-f", "0", "-1", "500",
  "site.yml", "deploy.yml", "nope.yml", "inventory", "roles", "--graph", "--list", "--host", "--yaml", "encrypt", "decrypt", "view", "encrypt_string", "create", "rekey",
  "collection", "role", "install", "list", "init", "-r", "requirements.yml", "community.general", "nope.nope", "dump", "--only-changed", "-l", "-s", "'s/a/b/'", "-i",
  "'/x/d'", "'s/[/x/'", "deploy@10.0.1.11", "10.0.1.13", "-R", "&&", "||", ";", "|", "grep", "head", "wc", "-l", ">", ">>", "out.txt", "'", "\"", "\\", "{{", "}}", "{%", "%}", "''", "--"];
// Snippets spliced into YAML files: broken indentation, Jinja, odd keys.
const SNIPPETS = ["\n  - name: x\n      apt: y\n", "\n\t- tab\n", "{{ nope }}", "\"{{ nope.attr }}\"", "{% if %}", "{% for x in y %}", "\n- hosts:\n", ": : :", "[", "{",
  "\n    when: nope\n", "\n    loop: \"{{ 1 }}\"\n", "\n    notify: missing\n", "\n    include: x.yml\n", "\n    block:\n      - debug: msg=hi\n    rescue: 3\n",
  "\n- import_playbook: site.yml\n", "!vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  zz\n", "\n    register: r\n    changed_when: r.nope.nope\n", "\n    serial: '50%'\n",
  "\n    tags: [never]\n", "\n    delegate_to: \"{{ nope }}\"\n", "\n    run_once: yes\n", "\n    async: 10\n    poll: 0\n", "\n    vars:\n      a: \"{{ a }}\"\n", "---", "...", "&anchor", "*alias"];

const rounds = Number(process.argv[2] || 2500);
let n = 0;
const fails = new Map();
const attempt = (sc, label, fn) => {
  n++;
  try {
    let r = fn();
    for (let k = 0; r && r.prompt && k < 3; k++) r = r.prompt.answer(pick(["", "yes", "practice-vault-pass", "practice-sudo", "wrong"]));
  } catch (e) {
    const key = String(e && e.stack ? e.stack.split("\n").slice(0, 2).join(" | ") : e);
    if (!fails.has(key)) fails.set(key, `${sc.id}: ${label}`);
  }
};

for (const sc of SCENARIOS) {
  const sim = new Sim(sc);
  const files = sim.projectFiles();
  const heavy = sc.hosts.length > 50;
  for (let i = 0; i < (heavy ? 25 : rounds / SCENARIOS.length * 2); i++) {
    const kind = rnd(10);
    if (kind < 6) {
      const cmd = [pick(TOOLS), ...Array.from({ length: rnd(7) }, () => pick(WORDS))].join(" ");
      attempt(sc, cmd, () => sim.exec(cmd));
    } else if (kind < 8) {
      const f = pick(files);
      const text = sim.read(f) || "";
      const at = rnd(text.length + 1);
      const next = text.slice(0, at) + pick(SNIPPETS) + text.slice(at + rnd(6));
      attempt(sc, `edit ${f}`, () => { sim.save(f, next); return sim.exec(pick(["ansible-playbook " + (files.find((x) => /^[a-z]+\.yml$/.test(x) && x !== "requirements.yml") || "site.yml"), "ansible all -m ping", "ansible-inventory --list", "ansible-playbook site.yml --syntax-check"])); });
    } else {
      const cmd = pick(sc.tries) + " " + pick(WORDS);
      attempt(sc, cmd, () => sim.exec(cmd));
    }
    if (!heavy) try { sc.check(sim); sc.won(sim); } catch (e) { fails.set("check: " + e.message, sc.id); }
  }
}

console.log(`fuzz: ${n} commands and edits, ${fails.size} distinct exceptions`);
for (const [err, where] of fails) console.log(`  ${where}\n    ${err}`);
process.exit(fails.size ? 1 : 0);
