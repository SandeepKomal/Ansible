// Drives the playground without a browser: every scenario starts broken,
// tempting wrong moves leave it broken, and the intended fix solves it.
// Output and errors are checked against what Ansible prints.
// Run with: node tests/check_playground.js
"use strict";
const path = require("path");
const assert = require("assert");

for (const f of ["lang", "sim", "scenarios"]) require(path.resolve(__dirname, "../site/" + f + ".js"));
const { Sim, shellSplit } = globalThis.AQSim;
const { SCENARIOS, GROUPS } = globalThis.AQScenarios;

// Run a command, answering prompts in order; returns the printed text.
function run(sim, cmd, answers = []) {
  let r = sim.exec(cmd);
  let out = r.out;
  const queue = [...answers];
  while (r.prompt) {
    assert.ok(queue.length, `"${cmd}" prompted "${r.prompt.text}" with no answer given`);
    r = r.prompt.answer(queue.shift());
    out = out.concat(r.out);
  }
  if (r.edit) sim.lastEdit = r.edit;
  return out.map(([t]) => t).join("\n");
}
const fresh = (id) => new Sim(SCENARIOS.find((s) => s.id === id));
const won = (sim) => sim.scenario.won(sim);
const edit = (sim, file, from, to) => {
  const text = sim.read(file);
  assert.ok(text.includes(from), `${file} should contain ${JSON.stringify(from)}`);
  sim.save(file, text.replace(from, to));
};

assert.deepStrictEqual(shellSplit(`ansible web -a 'grep -c x /etc/hosts' && ls`), ["ansible", "web", "-a", "grep -c x /etc/hosts", { op: "&&" }, "ls"]);

// Every scenario: well formed, starts broken, and its suggested commands print something.
const ids = new Set();
for (const s of SCENARIOS) {
  assert.ok(!ids.has(s.id), `${s.id}: duplicate id`);
  ids.add(s.id);
  for (const k of ["title", "story", "goal", "lesson", "error", "group"]) assert.ok(typeof s[k] === "string" && s[k].length > 3, `${s.id}: ${k}`);
  assert.match(s.level, /^\d\d$/, `${s.id}: level`);
  assert.strictEqual(s.hints.length, 3, `${s.id}: three hints`);
  const sim = new Sim(s);
  assert.ok(!won(sim), `${s.id}: must start broken`);
  const c = s.check(sim);
  assert.ok(c.label && typeof c.ok === "boolean" && c.text !== undefined, `${s.id}: check`);
  for (const cmd of s.tries) assert.ok(run(sim, cmd).length > 0, `${s.id}: "${cmd}" prints something`);
}
assert.ok(SCENARIOS.length >= 30, "at least 30 scenarios");
assert.deepStrictEqual(GROUPS.flatMap(([, x]) => x).sort(), [...ids].sort(), "every scenario is in one group");

let sim;

// publickey: -u is weaker than inventory; -e works once but leaves the inventory wrong.
sim = fresh("publickey");
assert.match(run(sim, "ansible web -m ping"), /web-04 \| UNREACHABLE! => \{\n {4}"changed": false,\n {4}"msg": "Failed to connect to the host via ssh: root@10\.0\.1\.14: Permission denied \(publickey\)\.",/);
assert.match(run(sim, "ansible-inventory --host web-04"), /"ansible_user": "root"/);
run(sim, "ansible web -m ping -u deploy");
assert.ok(!won(sim), "-u loses to ansible_user");
assert.match(run(sim, "ansible web -m ping -e ansible_user=deploy"), /web-04 \| SUCCESS/);
assert.ok(!won(sim), "-e fixes one run only");
run(sim, "rm inventory/host_vars/web-04.yml");
run(sim, "ansible web -m ping");
assert.ok(won(sim), "publickey solved");

// timeout: a longer timeout only waits longer.
sim = fresh("timeout");
assert.match(run(sim, "ansible db -m ping"), /ssh: connect to host 10\.0\.2\.21 port 22: Connection timed out/);
run(sim, "ansible db -m ping -T 60");
assert.ok(!won(sim));
run(sim, "sed -i 's/10.0.2.21/10.0.2.12/' inventory/hosts.ini");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "timeout solved");

// hostkey: switching the check off is not the fix.
sim = fresh("hostkey");
assert.match(run(sim, "ansible web -m ping"), /REMOTE HOST IDENTIFICATION HAS CHANGED![\s\S]*Host key verification failed\./);
run(sim, "sed -i 's/host_key_checking = True/host_key_checking = False/' ansible.cfg");
assert.match(run(sim, "ansible web -m ping"), /web-03 \| SUCCESS/);
assert.ok(!won(sim), "disabling host key checking does not count");
sim = fresh("hostkey");
assert.match(run(sim, "ssh-keygen -R 10.0.1.13"), /# Host 10\.0\.1\.13 found: line 3/);
assert.match(run(sim, "ansible web -m ping"), /web-03 \| UNREACHABLE![\s\S]*Host key verification failed\./);
run(sim, "ssh-keyscan 10.0.1.13 >> ~/.ssh/known_hosts");
run(sim, "ansible web -m ping");
assert.ok(won(sim), "hostkey solved with keyscan");
sim = fresh("hostkey");
run(sim, "ssh-keygen -R 10.0.1.13");
assert.match(run(sim, "ssh deploy@10.0.1.13", ["yes"]), /Permanently added '10\.0\.1\.13'/);
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "hostkey solved by accepting the key");

// sudopass
sim = fresh("sudopass");
assert.match(run(sim, "ansible-playbook site.yml"), /fatal: \[web-03\]: FAILED! => \{"msg": "Missing sudo password"\}/);
assert.match(run(sim, "ssh deploy@10.0.1.13 sudo -n true"), /sudo: a password is required/);
run(sim, "ansible-playbook site.yml -b");
assert.ok(!won(sim));
run(sim, "sed -i '/become: true/d' site.yml");
assert.match(run(sim, "ansible-playbook site.yml"), /Failed to lock apt for exclusive operation/);
assert.ok(!won(sim), "dropping become is not the fix");
sim = fresh("sudopass");
assert.match(run(sim, "ansible-playbook site.yml -K", ["wrong"]), /"msg": "Incorrect sudo password"/);
assert.ok(!won(sim));
run(sim, "ansible-playbook site.yml -K", ["practice-sudo"]);
assert.ok(won(sim), "sudopass solved");

// nohosts: a green run that did nothing; --limit cannot add hosts.
sim = fresh("nohosts");
const nohosts = run(sim, "ansible-playbook site.yml");
assert.match(nohosts, /\[WARNING\]: Could not match supplied host pattern, ignoring: webservers\n\nPLAY \[Message of the day\] \*+\nskipping: no hosts matched\n\nPLAY RECAP \*+/);
assert.strictEqual(sim.runs[sim.runs.length - 1].ok, true, "the run is green");
run(sim, "ansible-playbook site.yml --limit web");
assert.ok(!won(sim));
run(sim, "sed -i 's/hosts: webservers/hosts: web/' site.yml");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "nohosts solved");

// limit: too wide a limit cannot be undone.
sim = fresh("limit");
assert.match(run(sim, "ansible-playbook patch.yml --limit web01"), /\[WARNING\]: Could not match supplied host pattern, ignoring: web01\nERROR! Specified inventory, host pattern and\/or --limit leaves us with no hosts to target\./);
run(sim, "ansible-playbook patch.yml --limit 'web*'");
assert.ok(!won(sim), "patching every host is not the canary");
assert.match(sim.scenario.check(sim).text, /before the canary/);
sim = fresh("limit");
assert.match(run(sim, "ansible-playbook patch.yml --limit web-01 --list-hosts"), /hosts \(1\):\n {6}web-01/);
run(sim, "ansible-playbook patch.yml --limit web-01");
assert.ok(won(sim), "limit solved");

// python: interpreter paths and skipping facts do not install Python.
sim = fresh("python");
assert.match(run(sim, "ansible-playbook site.yml"), /"module_stdout": "\/bin\/sh: 1: \/usr\/bin\/python3: not found\\r\\n"[\s\S]*"msg": "The following modules failed to execute: ansible.legacy.setup\\n"/);
run(sim, "ansible-playbook site.yml -e ansible_python_interpreter=/usr/bin/python");
assert.ok(!won(sim));
run(sim, "sed -i 's/  become: true/  become: true\\n  gather_facts: false/' site.yml");
assert.match(run(sim, "ansible-playbook site.yml"), /you probably need to set the interpreter/);
assert.ok(!won(sim));
sim = fresh("python");
assert.match(run(sim, "ansible edge-01 -m raw -a 'apt-get install -y python3' -b"), /edge-01 \| CHANGED \| rc=0 >>/);
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "python solved");

// indent: the YAML error points at the line, with the caret.
sim = fresh("indent");
assert.match(run(sim, "ansible-playbook site.yml --syntax-check"), /ERROR! We were unable to read either as JSON nor YAML, these are the errors we got from each:\nJSON: Expecting value: line 1 column 1 \(char 0\)\n\nSyntax Error while loading YAML.\n {2}mapping values are not allowed in this context\n\nThe error appears to be in '\/home\/ops\/project\/site.yml': line 12, column 32, but may\nbe elsewhere in the file depending on the exact syntax problem.\n\nThe offending line appears to be:\n\n {4}- name: Start nginx\n {8}ansible.builtin.service:\n {31}\^ here/);
run(sim, "sed -i '12s/^        ansible/      ansible/' site.yml");
assert.match(run(sim, "ansible-playbook site.yml --syntax-check"), /^\nplaybook: site.yml$/);
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "indent solved");

// param
sim = fresh("param");
assert.match(run(sim, "ansible-playbook site.yml"), /"msg": "Unsupported parameters for \(ansible.builtin.apt\) module: package_name. Supported parameters include: allow_change_held_packages, [^"]*, upgrade \(default-release, install-recommends, package, pkg, update-cache\)."/);
assert.match(run(sim, "ansible-doc ansible.builtin.apt"), /> ANSIBLE.BUILTIN.APT/);
run(sim, "sed -i 's/package_name:/name:/' site.yml");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "param solved");

// registerloop
sim = fresh("registerloop");
assert.match(run(sim, "ansible-playbook report.yml"), /'dict object' has no attribute 'stdout'. 'dict object' has no attribute 'stdout'/);
assert.match(run(sim, "ansible-playbook report.yml"), /ok: \[web-01\] => \(item=git\)/);
edit(sim, "report.yml", "versions.stdout }}", "versions.results | map(attribute='stdout') | list }}");
assert.match(run(sim, "ansible-playbook report.yml"), /"msg": \[\n {8}"git version 2.43.0",/);
assert.ok(won(sim), "registerloop solved");

// copytemplate: restarting reads the same broken file.
sim = fresh("copytemplate");
assert.match(run(sim, "ansible web -a 'cat /etc/app/app.conf'"), /port = \{\{ app_port \}\}/);
assert.match(run(sim, "ansible web -m service -a 'name=app state=restarted' -b"), /Unable to restart service app: Job for app.service failed because the control process exited with error code/);
assert.match(run(sim, "ansible-playbook site.yml"), /Unable to start service app/);
run(sim, "sed -i 's/ansible.builtin.copy:/ansible.builtin.template:/' roles/app/tasks/main.yml");
assert.match(run(sim, "ansible-playbook site.yml"), /Could not find or access 'app.conf.j2'\\nSearched in:\\n\\t\/home\/ops\/project\/roles\/app\/templates\/app.conf.j2/);
run(sim, "mkdir roles/app/templates && mv roles/app/files/app.conf.j2 roles/app/templates/");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "copytemplate solved");

// osfamily: skipping Rocky is not the fix.
sim = fresh("osfamily");
assert.match(run(sim, "ansible-playbook site.yml"), /fatal: \[web-02\]: FAILED! => \{"changed": false, "failures": \["No package apache2 available."\], "msg": "Failed to install some of the specified packages", "rc": 1, "results": \[\]\}/);
assert.match(run(sim, "ansible web -m setup -a 'filter=ansible_os_family'"), /"ansible_os_family": "RedHat"/);
edit(sim, "roles/web/tasks/main.yml", "    state: present\n", "    state: present\n  when: ansible_facts['os_family'] == 'Debian'\n");
run(sim, "ansible-playbook site.yml");
assert.ok(!won(sim));
sim = fresh("osfamily");
sim.save("roles/web/tasks/main.yml", "---\n- name: Load the names for this OS\n  ansible.builtin.include_vars: \"{{ ansible_facts['os_family'] }}.yml\"\n\n- name: Install the web server\n  ansible.builtin.package:\n    name: \"{{ web_package }}\"\n    state: present\n\n- name: Start the web server\n  ansible.builtin.service:\n    name: \"{{ web_service }}\"\n    state: started\n    enabled: true\n");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "osfamily solved");

// tagskip: running without --tags works today but leaves the pipeline broken.
sim = fresh("tagskip");
assert.doesNotMatch(run(sim, "ansible-playbook deploy.yml --tags deploy --list-tasks"), /migrations/);
assert.match(run(sim, "ansible-playbook deploy.yml --tags deploy"), /Status code was 503 and not \[200\]: HTTP Error 503: Service Unavailable/);
run(sim, "ansible-playbook deploy.yml");
assert.ok(!won(sim), "a full run hides the problem");
sim = fresh("tagskip");
edit(sim, "deploy.yml", "      run_once: true\n", "      run_once: true\n      tags: [deploy]\n");
run(sim, "ansible-playbook deploy.yml --tags deploy");
assert.ok(won(sim), "tagskip solved");

// rescue: ignore_errors starts a broken release.
sim = fresh("rescue");
assert.match(run(sim, "ansible-playbook deploy.yml"), /migration 0043_split_addresses failed/);
assert.ok(!sim.hosts["web-01"].services.app.running, "the failed deploy left the app stopped");
run(sim, "ansible web -m service -a 'name=app state=started' -b -e x=1");
sim = fresh("rescue");
edit(sim, "deploy.yml", "/opt/app/bin/migrate\n", "/opt/app/bin/migrate\n      ignore_errors: true\n");
assert.match(run(sim, "ansible-playbook deploy.yml"), /\.\.\.ignoring/);
assert.ok(!won(sim), "ignore_errors starts 3.0 broken");
sim = fresh("rescue");
sim.save("deploy.yml", "---\n- name: Deploy the orders app\n  hosts: web\n  become: true\n  tasks:\n    - name: Stop the app\n      ansible.builtin.service:\n        name: app\n        state: stopped\n\n    - name: Release\n      block:\n        - name: Install the release\n          ansible.builtin.copy:\n            content: \"{{ app_version }}\\n\"\n            dest: /opt/app/VERSION\n            mode: \"0644\"\n\n        - name: Run database migrations\n          ansible.builtin.command: /opt/app/bin/migrate\n      rescue:\n        - name: Roll back\n          ansible.builtin.copy:\n            content: \"{{ previous_version }}\\n\"\n            dest: /opt/app/VERSION\n            mode: \"0644\"\n      always:\n        - name: Start the app\n          ansible.builtin.service:\n            name: app\n            state: started\n");
const rescued = run(sim, "ansible-playbook deploy.yml");
assert.match(rescued, /TASK \[Roll back\][\s\S]*TASK \[Start the app\][\s\S]*rescued=1/);
assert.ok(won(sim), "rescue solved");

// undefined: -e works once only.
sim = fresh("undefined");
assert.match(run(sim, "ansible-playbook site.yml"), /fatal: \[api-01\]: FAILED! => \{"changed": false, "msg": "AnsibleUndefinedVariable: 'nginx_worker_connections' is undefined. 'nginx_worker_connections' is undefined"\}/);
run(sim, "ansible-playbook site.yml -e nginx_worker_connections=1024");
assert.ok(!won(sim));
run(sim, "mkdir roles/nginx/defaults && echo 'nginx_worker_connections: 1024' > roles/nginx/defaults/main.yml");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "undefined solved");

// hostvars precedence
sim = fresh("hostvars");
assert.match(run(sim, "ansible-inventory --host web-02"), /"app_version": "2.1"/);
run(sim, "ansible-playbook deploy.yml -e app_version=2.4");
assert.ok(!won(sim), "-e is not the fix");
sim = fresh("hostvars");
sim.save("inventory/group_vars/all.yml", "---\nansible_user: deploy\napp_version: \"2.4\"\n");
run(sim, "ansible-playbook deploy.yml");
assert.strictEqual(sim.hosts["web-02"].files["/opt/app/VERSION"].content, "2.1\n", "group_vars/all cannot beat host_vars");
run(sim, "rm inventory/host_vars/web-02.yml");
run(sim, "ansible-playbook deploy.yml");
assert.ok(won(sim), "hostvars solved");

// quotes
sim = fresh("quotes");
assert.match(run(sim, "ansible-playbook site.yml"), /found unacceptable key \(unhashable type: 'AnsibleMapping'\)\n\nThe error appears to be in '\/home\/ops\/project\/site.yml': line 8, column 15[\s\S]*\^ here\nWe could be wrong, but this one looks like it might be an issue with\nmissing quotes/);
run(sim, "sed -i 's|path: {{ app_dir }}/releases|path: \"{{ app_dir }}/releases\"|' site.yml");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "quotes solved");

// stringfalse: other spellings are strings too; JSON is not the CI command.
sim = fresh("stringfalse");
assert.match(run(sim, "ansible-playbook site.yml -e install_debug_tools=false"), /changed: \[web-01\]/);
assert.ok(!won(sim));
run(sim, "ansible-playbook site.yml -e install_debug_tools=False");
assert.ok(!won(sim));
sim = fresh("stringfalse");
run(sim, `ansible-playbook site.yml -e '{"install_debug_tools": false}'`);
assert.ok(!won(sim), "a JSON boolean is not the CI's command");
run(sim, "sed -i 's/when: install_debug_tools$/when: install_debug_tools | bool/' site.yml");
assert.match(run(sim, "ansible-playbook site.yml -e install_debug_tools=false -v"), /skipping: \[web-01\] => \{"changed": false, "false_condition": "install_debug_tools \| bool", "skip_reason": "Conditional result was False"\}/);
assert.ok(won(sim), "stringfalse solved");

// loopdict: with_items does not split a dictionary.
sim = fresh("loopdict");
assert.match(run(sim, "ansible-playbook users.yml"), /Invalid data passed to 'loop', it requires a list, got this instead: \{'alice': \{'shell': '\/bin\/bash'\}, 'bob': \{'shell': '\/bin\/zsh'\}\}/);
edit(sim, "users.yml", `loop: "{{ team }}"`, `with_items: "{{ team }}"`);
assert.match(run(sim, "ansible-playbook users.yml"), /'dict object' has no attribute 'key'/);
assert.ok(!won(sim));
edit(sim, "users.yml", `with_items: "{{ team }}"`, `loop: "{{ team | dict2items }}"`);
assert.match(run(sim, "ansible-playbook users.yml"), /changed: \[web-01\] => \(item=\{'key': 'alice', 'value': \{'shell': '\/bin\/bash'\}\}\)/);
assert.ok(won(sim), "loopdict solved");

// hostvarsfacts
sim = fresh("hostvarsfacts");
assert.match(run(sim, "ansible-playbook lb.yml"), /"msg": "AnsibleUndefinedVariable: 'ansible.vars.hostvars.HostVarsVars object' has no attribute 'ansible_default_ipv4'. 'ansible.vars.hostvars.HostVarsVars object' has no attribute 'ansible_default_ipv4'"/);
edit(sim, "lb.yml", "---\n", "---\n- name: Gather the web servers' facts\n  hosts: web\n  gather_facts: true\n  tasks: []\n\n");
run(sim, "ansible-playbook lb.yml");
assert.ok(won(sim), "hostvarsfacts solved");

// collection: installing by hand is not enough; the short name still needs the collection.
sim = fresh("collection");
assert.match(run(sim, "ansible-playbook firewall.yml"), /^ERROR! couldn't resolve module\/action 'community.general.ufw'. This often indicates a misspelling, missing collection, or incorrect module path.\n\nThe error appears to be in '\/home\/ops\/project\/firewall.yml': line 6, column 7/m);
edit(sim, "firewall.yml", "community.general.ufw:", "ufw:");
assert.match(run(sim, "ansible-playbook firewall.yml"), /couldn't resolve module\/action 'ufw'/);
edit(sim, "firewall.yml", "ufw:", "community.general.ufw:");
assert.match(run(sim, "ansible-galaxy collection install community.general"), /community.general:10.7.4 was installed successfully/);
run(sim, "ansible-playbook firewall.yml");
assert.ok(!won(sim), "requirements.yml must list it");
sim.save("requirements.yml", "---\ncollections:\n  - name: community.general\n    version: \"10.7.4\"\n");
run(sim, "ansible-galaxy collection install -r requirements.yml");
run(sim, "ansible-playbook firewall.yml");
assert.ok(won(sim), "collection solved");
assert.match(run(sim, "ansible-galaxy collection list"), /community.general 10.7.4/);

// rolevars
sim = fresh("rolevars");
assert.match(run(sim, "ansible web -m debug -a var=nginx_port"), /"nginx_port": 8080/);
run(sim, "ansible-playbook site.yml");
assert.match(sim.hosts["web-01"].files["/etc/nginx/conf.d/site.conf"].content, /listen 80;/);
run(sim, "ansible-playbook site.yml -e nginx_port=8080");
assert.ok(!won(sim), "-e is not the fix");
run(sim, "mv roles/nginx/vars roles/nginx/defaults");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "rolevars solved");

// roledir
sim = fresh("roledir");
assert.match(run(sim, "ansible-playbook site.yml --list-tasks"), /tasks:\n*$/);
run(sim, "mv roles/nginx/task roles/nginx/tasks");
assert.match(run(sim, "ansible-playbook site.yml --list-tasks"), /nginx : Install nginx\tTAGS: \[\]/);
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "roledir solved");

// rolemissing
sim = fresh("rolemissing");
assert.match(run(sim, "ansible-playbook site.yml"), /ERROR! the role 'baseline' was not found in \/home\/ops\/project\/roles:\/home\/ops\/project\/roles:\/home\/ops\/project/);
assert.match(run(sim, "ansible-galaxy install baseline"), /was NOT installed successfully/);
assert.match(run(sim, "ansible-galaxy install -r requirements.yml"), /- baseline \(v1.4.0\) was installed successfully/);
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "rolemissing solved");

// shell: changed_when hides the report but not the duplicates.
sim = fresh("shell");
run(sim, "ansible-playbook site.yml");
assert.match(run(sim, "ansible web -a 'grep -c db.internal /etc/hosts'"), /web-01 \| CHANGED \| rc=0 >>\n2/);
edit(sim, "site.yml", "/etc/hosts\n", "/etc/hosts\n      changed_when: false\n");
run(sim, "ansible-playbook site.yml");
assert.ok(!won(sim));
sim = fresh("shell");
edit(sim, "site.yml", `ansible.builtin.shell: echo "10.0.2.11 db.internal" >> /etc/hosts`, `ansible.builtin.lineinfile:\n        path: /etc/hosts\n        line: "10.0.2.11 db.internal"`);
assert.match(run(sim, "ansible-playbook site.yml"), /changed=0/);
assert.ok(won(sim), "shell solved");

// changedwhen
sim = fresh("changedwhen");
run(sim, "ansible-playbook site.yml");
assert.match(run(sim, "ansible-playbook site.yml"), /RUNNING HANDLER \[app : Restart app\]/);
edit(sim, "roles/app/tasks/main.yml", "check-config\n  notify: Restart app\n", "check-config\n");
run(sim, "ansible-playbook site.yml");
run(sim, "ansible-playbook site.yml");
assert.ok(!won(sim), "removing notify still reports changed");
edit(sim, "roles/app/tasks/main.yml", "check-config\n", "check-config\n  changed_when: false\n");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "changedwhen solved");

// handlernever: running the play again never fires the handler.
sim = fresh("handlernever");
assert.doesNotMatch(run(sim, "ansible-playbook site.yml"), /RUNNING HANDLER/);
assert.ok(!won(sim));
assert.match(run(sim, "ansible web -m service -a 'name=nginx state=reloaded' -b"), /web-01 \| CHANGED/);
assert.ok(won(sim), "handlernever solved");

// handlername
sim = fresh("handlername");
assert.match(run(sim, "ansible-playbook site.yml"), /ERROR! The requested handler 'reload nginx' was not found in either the main handlers list nor in the listening handlers list/);
run(sim, "sed -i 's/notify: reload nginx/notify: Reload nginx/' site.yml");
run(sim, "ansible-playbook site.yml");
assert.ok(!won(sim), "the file is already there, so nothing notifies");
run(sim, "ansible web -m service -a 'name=nginx state=reloaded' -b");
assert.ok(won(sim), "handlername solved");

// flush: an always-restart task is not idempotent.
sim = fresh("flush");
assert.match(run(sim, "ansible-playbook site.yml"), /"msg": "Status code was -1 and not \[200\]: Request failed: <urlopen error \[Errno 111\] Connection refused>"/);
edit(sim, "site.yml", "    - name: Check health", "    - name: Restart now\n      ansible.builtin.service:\n        name: app\n        state: restarted\n\n    - name: Check health");
run(sim, "ansible-playbook site.yml");
run(sim, "ansible-playbook site.yml");
assert.ok(!won(sim), "restarting every run is not the fix");
sim = fresh("flush");
run(sim, "ansible-playbook site.yml");
edit(sim, "site.yml", "    - name: Check health", "    - name: Apply the new config now\n      ansible.builtin.meta: flush_handlers\n\n    - name: Check health");
run(sim, "ansible web -m service -a 'name=app state=restarted' -b");
run(sim, "ansible-playbook site.yml");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "flush solved");
sim = fresh("flush");
edit(sim, "site.yml", "    - name: Check health", "    - ansible.builtin.meta: flush_handlers\n\n    - name: Check health");
assert.match(run(sim, "ansible-playbook site.yml"), /RUNNING HANDLER \[Restart app\][\s\S]*TASK \[Check health on the new port\] \*+\nok: \[web-01\]/);
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "flush solved from fresh");

// checkmode: applying without a preview is not the goal.
sim = fresh("checkmode");
assert.match(run(sim, "ansible-playbook db.yml --check --diff"), /skipping: \[db-01\]/);
run(sim, "ansible-playbook db.yml");
assert.ok(!won(sim));
sim = fresh("checkmode");
edit(sim, "db.yml", "ansible.builtin.shell: sed -i 's/^max_connections.*/max_connections = 500/' /etc/postgresql/16/main/postgresql.conf", "ansible.builtin.lineinfile:\n        path: /etc/postgresql/16/main/postgresql.conf\n        regexp: '^max_connections'\n        line: max_connections = 500");
assert.match(run(sim, "ansible-playbook db.yml --check --diff"), /--- before: \/etc\/postgresql\/16\/main\/postgresql.conf \(content\)\n\+\+\+ after: \/etc\/postgresql\/16\/main\/postgresql.conf \(content\)\n@@ -1,3 \+1,3 @@\n listen_addresses = '\*'\n-max_connections = 100\n\+max_connections = 500/);
assert.ok(won(sim), "checkmode solved");

// vault
sim = fresh("vault");
assert.match(run(sim, "ansible-playbook site.yml"), /^ERROR! Attempting to decrypt but no vault secrets found$/m);
assert.match(run(sim, "ansible-playbook site.yml -J", ["wrong"]), /Decryption failed \(no vault secrets were found that could decrypt\) on \/home\/ops\/project\/inventory\/group_vars\/all\/vault.yml/);
assert.match(run(sim, "ansible-vault view inventory/group_vars/all/vault.yml --vault-password-file ~/.vault_pass.txt"), /vault_db_password: practice-db-pass/);
run(sim, "ansible-vault decrypt inventory/group_vars/all/vault.yml --vault-password-file ~/.vault_pass.txt");
run(sim, "ansible-playbook site.yml");
assert.ok(!won(sim), "decrypting the file in place is not the fix");
sim = fresh("vault");
run(sim, "ansible-playbook site.yml --vault-password-file ~/.vault_pass.txt");
assert.ok(won(sim), "vault solved with a password file");
sim = fresh("vault");
run(sim, "ansible-playbook site.yml -J", ["practice-vault-pass"]);
assert.ok(won(sim), "vault solved with a prompt");

// nolog
sim = fresh("nolog");
assert.match(run(sim, "ansible-playbook site.yml -v | grep practice"), /"practice-admin-pass"/);
run(sim, "ansible-playbook site.yml");
assert.ok(!won(sim), "hiding -v is not the fix");
edit(sim, "site.yml", "      changed_when: false\n", "      changed_when: false\n      no_log: true\n");
assert.match(run(sim, "ansible-playbook site.yml -v"), /ok: \[web-01\] => \{"censored": "the output has been hidden due to the fact that 'no_log: true' was specified for this result", "changed": false\}/);
assert.ok(won(sim), "nolog solved");

// plaintext
sim = fresh("plaintext");
run(sim, "ansible-vault encrypt_string --vault-password-file ~/.vault_pass.txt 'practice-db-pass' --name db_password >> inventory/group_vars/all.yml");
run(sim, "sed -i '/db_password: practice-db-pass/d' inventory/group_vars/all.yml");
// The task has no_log, so even the decryption error is censored.
assert.match(run(sim, "ansible-playbook site.yml"), /fatal: \[web-01\]: FAILED! => \{"censored": "the output has been hidden/);
run(sim, "ansible-playbook site.yml --vault-password-file ~/.vault_pass.txt");
assert.ok(won(sim), "plaintext solved with encrypt_string");
sim = fresh("plaintext");
assert.match(run(sim, "ansible-vault encrypt inventory/group_vars/all.yml", ["practice-vault-pass", "practice-vault-pass"]), /Encryption successful/);
run(sim, "ansible-playbook site.yml -J", ["practice-vault-pass"]);
assert.ok(won(sim), "plaintext solved by encrypting the file");

// sudoers: a broken file locks Ansible out.
sim = fresh("sudoers");
run(sim, "ansible-playbook site.yml");
assert.match(run(sim, "ansible-playbook site.yml"), /"module_stderr": ">>> \/etc\/sudoers.d\/monitoring: syntax error near line 1 <<<\\nsudo: parse error in \/etc\/sudoers.d\/monitoring near line 1/);
assert.ok(!won(sim));
sim = fresh("sudoers");
edit(sim, "site.yml", `mode: "0440"\n`, `mode: "0440"\n        validate: visudo -cf %s\n`);
assert.match(run(sim, "ansible-playbook site.yml"), /"msg": "failed to validate"/);
assert.match(run(sim, "ansible web -m ping -b"), /SUCCESS/);
run(sim, "sed -i 's/NOPASSWD \\//NOPASSWD: \\//' templates/monitoring.sudoers.j2");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "sudoers solved");

// filemode: 0644 starts the app but exposes the secret.
sim = fresh("filemode");
run(sim, "ansible-playbook site.yml");
assert.match(run(sim, "ansible web -m stat -a path=/etc/app/app.env"), /"mode": "01130"/);
run(sim, `sed -i 's/mode: 600/mode: "0644"/' site.yml`);
run(sim, "ansible-playbook site.yml");
run(sim, "ansible web -m service -a 'name=app state=started' -b");
assert.ok(!won(sim), "world-readable is not the fix");
sim = fresh("filemode");
run(sim, `sed -i 's/mode: 600/mode: "0600"/' site.yml`);
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "filemode solved");

// serial: half the site is still too much.
sim = fresh("serial");
assert.match(run(sim, "ansible-playbook deploy.yml"), /NO MORE HOSTS LEFT/);
assert.ok(!won(sim));
run(sim, "ansible-playbook deploy.yml -e app_version=2.0");
edit(sim, "deploy.yml", "  become: true\n", "  become: true\n  serial: 2\n");
run(sim, "ansible-playbook deploy.yml");
assert.ok(!won(sim), "serial: 2 takes half the site down");
run(sim, "ansible-playbook deploy.yml -e app_version=2.0");
edit(sim, "deploy.yml", "serial: 2", "serial: 1");
const rolled = run(sim, "ansible-playbook deploy.yml");
assert.match(rolled, /fatal: \[web-01\][\s\S]*NO MORE HOSTS LEFT/);
assert.doesNotMatch(rolled, /web-02 .*: ok=[1-9]/);
assert.ok(won(sim), "serial solved");

// facts: forks alone get close; hundreds of forks kill the control node.
sim = fresh("facts");
assert.match(run(sim, "ansible-playbook baseline.yml"), /Playbook run took 0 days, 0 hours, 53 minutes, 20 seconds$/);
assert.ok(!won(sim));
run(sim, "echo 'forks = 500' >> ansible.cfg");
assert.match(run(sim, "ansible-playbook baseline.yml"), /ERROR! A worker was found in a dead state/);
assert.ok(!won(sim));
sim = fresh("facts");
run(sim, "echo 'forks = 50' >> ansible.cfg");
run(sim, "ansible-playbook baseline.yml");
assert.ok(!won(sim), "forks alone are not enough");
edit(sim, "baseline.yml", "  become: true\n", "  become: true\n  gather_subset: [min]\n");
run(sim, "ansible-playbook baseline.yml");
assert.ok(won(sim), "facts solved");
sim = fresh("facts");
edit(sim, "baseline.yml", "  become: true\n", "  become: true\n  gather_facts: false\n");
assert.match(run(sim, "ansible-playbook baseline.yml -f 50"), /The conditional check 'ansible_facts\['os_family'\] == 'Debian'' failed/);

// runonce: serial makes them wait but still runs every host's migration.
sim = fresh("runonce");
assert.match(run(sim, "ansible-playbook deploy.yml"), /"stderr": "migration lock held by web-01; another migration is running"/);
sim = fresh("runonce");
edit(sim, "deploy.yml", "  become: true\n", "  become: true\n  serial: 1\n");
run(sim, "ansible-playbook deploy.yml");
assert.ok(!won(sim), "serial is not run_once");
sim = fresh("runonce");
edit(sim, "deploy.yml", "/opt/app/bin/migrate\n", "/opt/app/bin/migrate\n      run_once: true\n");
run(sim, "ansible-playbook deploy.yml");
assert.ok(won(sim), "runonce solved");

// delegate
sim = fresh("delegate");
assert.match(run(sim, "ansible-playbook deploy.yml"), /"msg": "\[Errno 2\] No such file or directory: b'\/usr\/local\/bin\/lb-ctl'"/);
assert.ok(!won(sim));
sim = fresh("delegate");
sim.save("deploy.yml", sim.read("deploy.yml").replace(/(lb-ctl (?:disable|enable) \{\{ inventory_hostname \}\}\n)/g, "$1      delegate_to: lb-01\n"));
assert.match(run(sim, "ansible-playbook deploy.yml"), /changed: \[web-01 -> lb-01\]/);
assert.ok(won(sim), "delegate solved");

// upgrade
sim = fresh("upgrade");
assert.match(run(sim, "ansible-playbook site.yml"), /^ERROR! \[DEPRECATED\]: ansible.builtin.include has been removed. Use include_tasks or import_tasks instead. This feature was removed from ansible-core in a release after 2023-05-16. Please update your playbooks.$/m);
run(sim, "sed -i 's/- include: /- ansible.builtin.include: /' site.yml");
assert.match(run(sim, "ansible-playbook site.yml"), /ansible.builtin.include has been removed/);
run(sim, "sed -i 's/- ansible.builtin.include: /- ansible.builtin.include_tasks: /' site.yml");
assert.match(run(sim, "ansible-playbook site.yml"), /included: \/home\/ops\/project\/tasks\/packages.yml for web-01, web-02/);
assert.ok(won(sim), "upgrade solved");

// async: a longer connect timeout does not help.
sim = fresh("async");
assert.match(run(sim, "ansible-playbook reindex.yml"), /fatal: \[db-01\]: UNREACHABLE! => \{"changed": false, "msg": "Failed to connect to the host via ssh: client_loop: send disconnect: Broken pipe", "unreachable": true\}/);
run(sim, "ansible-playbook reindex.yml -T 3600");
assert.ok(!won(sim));
edit(sim, "reindex.yml", "--all\n", "--all\n      async: 3600\n      poll: 30\n");
assert.match(run(sim, "ansible-playbook reindex.yml"), /ASYNC POLL on db-01: jid=j\d+\.\d+ started=1 finished=0/);
assert.ok(won(sim), "async solved");

// aptlock: deleting the lock corrupts dpkg; waiting is the fix.
sim = fresh("aptlock");
assert.match(run(sim, "ansible-playbook site.yml"), /"msg": "Failed to lock apt for exclusive operation: Failed to lock directory \/var\/lib\/apt\/lists\/: E:Could not get lock \/var\/lib\/apt\/lists\/lock. It is held by process 2481 \(apt-get\)"/);
run(sim, "ansible web -b -m shell -a 'rm /var/lib/dpkg/lock-frontend'");
assert.match(run(sim, "ansible-playbook site.yml"), /E: dpkg was interrupted, you must manually run 'dpkg --configure -a' to correct the problem/);
assert.ok(!won(sim), "removing the lock is not the fix");
sim = fresh("aptlock");
edit(sim, "site.yml", "state: present\n", "state: present\n        lock_timeout: 120\n");
run(sim, "ansible-playbook site.yml");
assert.ok(!won(sim), "two minutes is not long enough");
edit(sim, "site.yml", "lock_timeout: 120", "lock_timeout: 600");
run(sim, "ansible-playbook site.yml");
assert.ok(won(sim), "aptlock solved");

// becomeuser: dropping become_user runs as root; world-readable temp files are not the fix.
sim = fresh("becomeuser");
assert.match(run(sim, "ansible-playbook db.yml"), /Failed to set permissions on the temporary files Ansible needs to create when becoming an unprivileged user \(rc: 1, err: chmod: invalid mode: 'A\+user:postgres:rx:allow'/);
run(sim, "sed -i '/become_user: postgres/d' db.yml");
assert.match(run(sim, "ansible-playbook db.yml"), /FATAL: {2}role \\"root\\" does not exist/);
sim = fresh("becomeuser");
run(sim, "echo 'allow_world_readable_tmpfiles = True' >> ansible.cfg");
run(sim, "ansible-playbook db.yml");
assert.ok(!won(sim), "world-readable temp files are not the fix");
sim = fresh("becomeuser");
run(sim, "ansible db -m apt -a name=acl -b");
run(sim, "ansible-playbook db.yml");
assert.ok(won(sim), "becomeuser solved with acl");
sim = fresh("becomeuser");
run(sim, "echo '[ssh_connection]' >> ansible.cfg && echo 'pipelining = True' >> ansible.cfg");
run(sim, "ansible-playbook db.yml");
assert.ok(won(sim), "becomeuser solved with pipelining");

// --- general behaviour ---------------------------------------------------------

sim = fresh("indent");
const okRun = (() => { run(sim, "sed -i '12s/^        ansible/      ansible/' site.yml"); return run(sim, "ansible-playbook site.yml"); })();
assert.match(okRun, /^\nPLAY \[Web servers\] \*{61}\n\nTASK \[Gathering Facts\] \*{57}\nok: \[web-01\]/);
assert.match(okRun, /PLAY RECAP \*{69}\nweb-01 {21}: ok=3 {4}changed=1 {4}unreachable=0 {4}failed=0 {4}skipped=0 {4}rescued=0 {4}ignored=0 {3}/);
assert.match(run(sim, "ansible-playbook site.yml"), /changed=0/);
assert.match(run(sim, "ansible-playbook nope.yml"), /ERROR! the playbook: nope.yml could not be found/);
assert.match(run(sim, "ansible-playbook site.yml --bogus"), /ansible-playbook: error: unrecognized arguments: --bogus/);
assert.match(run(sim, "ansible-playbook"), /error: the following arguments are required: playbook/);
assert.match(run(sim, "ansible-playbook site.yml -i nope.ini"), /\[WARNING\]: Unable to parse \/home\/ops\/project\/nope.ini as an inventory source/);
assert.match(run(sim, "ansible --version"), /^ansible \[core 2\.18\.6\]/);
assert.match(run(sim, "ansible-inventory --graph"), /@all:\n {2}\|--@ungrouped:\n {2}\|--@web:\n {2}\|  \|--web-01/);
assert.match(run(sim, "ansible-inventory --list"), /"_meta": \{\n {8}"hostvars": \{/);
assert.match(run(sim, "ansible all -m nope"), /ERROR! couldn't resolve module\/action 'nope'/);
assert.match(run(sim, "ansible web -m shell -a 'cat /nope'"), /web-01 \| FAILED \| rc=1 >>\ncat: \/nope: No such file or directorynon-zero return code/);
assert.match(run(sim, "ansible web -a 'nosuchcmd'"), /web-01 \| FAILED \| rc=2 >>\n\[Errno 2\] No such file or directory: b'nosuchcmd'/);
assert.match(run(sim, "ansible web -m apt -a 'name=nosuchpkg state=present' -b"), /"msg": "No package matching 'nosuchpkg' is available"/);
assert.match(run(sim, "ansible web -m service -a 'name=httpd state=started' -b"), /"msg": "Could not find the requested service httpd: host"/);
assert.match(run(sim, "ansible-playbook site.yml --list-tags"), /TASK TAGS: \[\]/);
assert.match(run(sim, "ansible-vault view site.yml --vault-password-file ~/.ssh/id_ed25519.pub"), /ERROR! input is not vault encrypted datasite.yml is not a vault encrypted file for site.yml/);
assert.match(run(sim, "cat nope"), /cat: nope: No such file or directory/);
assert.match(run(sim, "ansible-lint site.yml"), /needs a real machine/);
assert.deepStrictEqual(sim.exec("edit site.yml").edit.path, "site.yml");

// Duplicate keys warn, as PyYAML-based Ansible does.
sim = fresh("indent");
sim.save("site.yml", "---\n- name: Web\n  hosts: web\n  hosts: web\n  tasks: []\n");
assert.match(run(sim, "ansible-playbook site.yml"), /\[WARNING\]: While constructing a mapping from \/home\/ops\/project\/site.yml, line 2, column 3, found a duplicate dict key \(hosts\). Using last defined value only./);
sim.save("site.yml", "---\n- name: Web\n  hosts: web\n  when: true\n  tasks: []\n");
assert.match(run(sim, "ansible-playbook site.yml"), /ERROR! 'when' is not a valid attribute for a Play/);
sim.save("site.yml", "---\n- name: Web\n  hosts: web\n  tasks:\n    - name: x\n      ansible.builtin.apt: name=git\n      ansible.builtin.service: name=git\n");
assert.match(run(sim, "ansible-playbook site.yml"), /ERROR! conflicting action statements: ansible.builtin.apt, ansible.builtin.service/);
sim.save("site.yml", "---\n- name: Web\n  hosts: web\n  tasks:\n    - name: only a name\n");
assert.match(run(sim, "ansible-playbook site.yml"), /ERROR! no module\/action detected in task./);

// --- the cheat sheet, levels and troubleshooting reference ---------------------------

global.window = global.window || {};
require(path.resolve(__dirname, "../site/data.js"));
const Q = window.TRACK;
const fill = (id, cmd) => cmd.replace(/<([a-z-]+)>/g, (m, k) => (Q.fills[id] && Q.fills[id][k]) || Q.fills.any[k] || m);
const runsIn = (id, cmd) => {
  const s = fresh(id);
  const full = fill(id, cmd);
  if (/<[a-z-]+>/.test(full)) return false;
  const r = s.exec(full);
  let out = r.out;
  if (r.prompt) out = out.concat(r.prompt.answer(id === "vault" ? "practice-vault-pass" : "practice-sudo").out);
  return !out.some(([t, cls]) => cls === "na" || /command not found|^ERROR!|usage: |error: /.test(t));
};
for (const [cmd, , group, where] of Q.cheats) {
  if (where) assert.ok(runsIn(where === "any" ? "handlernever" : where, cmd), `cheat sheet (${group}): "${cmd}" should run in ${where}`);
  else assert.ok(!SCENARIOS.some((s) => runsIn(s.id, cmd)), `cheat sheet: "${cmd}" now runs in the playground; give it a Try`);
}
const levelIds = new Set(Q.levels.map((l) => l.id));
for (const s of SCENARIOS) assert.ok(levelIds.has(s.level), `${s.id}: level ${s.level} exists`);
for (const d of Q.doctor) for (const id of d.scenarios || []) assert.ok(ids.has(id), `troubleshooting "${d.id}" links to unknown scenario ${id}`);

console.log(`playground ok: ${SCENARIOS.length} scenarios in ${GROUPS.length} groups, ${Q.cheats.length} cheat sheet commands checked`);
