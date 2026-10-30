// The playground's incidents. Each one sets up a fleet and a project with
// one fault, and says how to tell it is fixed: won(sim) for the goal, and
// check(sim) for the live status beside the terminal. Plain data and
// small functions; the engine is in sim.js.
"use strict";

(function (root) {
  const { snapshot, confLine } = root.AQSim;
  const L = root.AQLang;

  // --- fleet and project helpers -------------------------------------------------

  const web = (n, extra) => ({ name: `web-0${n}`, ip: `10.0.1.1${n}`, ...extra });
  const WEB = [1, 2, 3, 4].map((n) => web(n));
  const DB = { name: "db-01", ip: "10.0.2.11" };
  const LB = { name: "lb-01", ip: "10.0.0.10" };
  const ini = (groups, vars) => Object.entries(groups).map(([g, hosts]) => `[${g}]\n` + hosts.map((h) => `${h.name} ansible_host=${h.ip}`).join("\n")).join("\n\n") + "\n" + (vars ? `\n${vars}\n` : "");
  const USER = "---\nansible_user: deploy\n";
  // A host running the team's app: its version, config and systemd unit.
  const app = (h, version = "2.4", port = 8080, extra = {}) => ({
    ...h, accounts: { app: { shell: "/usr/sbin/nologin", groups: [] } },
    files: { "/opt/app/VERSION": version + "\n", "/etc/app/app.conf": `port = ${port}\n`, "/etc/systemd/system/app.service": "[Unit]\nDescription=Orders app\n[Service]\nUser=app\nExecStart=/opt/app/bin/app\n", ...(extra.files || {}) },
    services: { app: {}, ...(extra.services || {}) }, packages: extra.packages
  });

  // --- what the checks look at --------------------------------------------------

  const runs = (sim, tool = "ansible-playbook") => sim.runs.filter((r) => r.tool === tool && !r.list && !r.syntax);
  const last = (sim, tool) => runs(sim, tool).pop();
  const lastAny = (sim) => sim.runs.filter((r) => !r.list && !r.syntax).pop();
  const okOn = (r, hosts) => !!r && !r.error && hosts.every((h) => r.stats[h] && !r.stats[h].failed && !r.stats[h].unreachable && r.stats[h].ok > 0);
  const changedTotal = (r) => Object.values(r.stats).reduce((n, s) => n + s.changed, 0);
  const file = (sim, h, p) => (sim.hosts[h].files[p] || { content: null }).content;
  const svc = (sim, h, unit) => sim.hosts[h].services[unit];
  const current = (sim, h, unit) => { const s = svc(sim, h, unit); return !!s && s.running && s.loaded === snapshot(sim.hosts[h], unit); };
  const version = (sim, h) => String(file(sim, h, "/opt/app/VERSION") || "").trim();
  const healthy = (sim, h) => { const r = root.AQSim.httpGet(sim, sim.hosts[h], "http://localhost:8080/healthz"); return r.status === 200; };
  const names = (list) => list.map((h) => h.name);
  const parse = (sim, p) => { try { return L.parseYaml(sim.read(p) || ""); } catch { return null; } };
  // Every task in a parsed play list or task list, blocks included.
  const tasksIn = (data) => {
    const out = [];
    const walk = (list) => { for (const t of Array.isArray(list) ? list : []) if (L.isDict(t)) { out.push(t); walk(t.block); walk(t.rescue); walk(t.always); walk(t.tasks); walk(t.pre_tasks); walk(t.post_tasks); walk(t.handlers); } };
    walk(data);
    return out;
  };
  const count = (n, total, what) => `${n} of ${total} ${what}`;
  const fleetCheck = (label, ok, text) => ({ label, ok, text });

  // --- the scenarios ---------------------------------------------------------------

  const SCENARIOS = [
    // Inventory and connection
    {
      id: "publickey", title: "Permission denied (publickey)", level: "02",
      story: "web-04 joined the fleet this morning. Every run since fails on it with UNREACHABLE, while the other web servers are fine.",
      goal: "Reach web-04 as the deploy user, the way the other hosts are reached, with no extra options.",
      error: "fatal: [web-04]: UNREACHABLE! => {\"changed\": false, \"msg\": \"Failed to connect to the host via ssh: root@10.0.1.14: Permission denied (publickey).\", \"unreachable\": true}",
      hosts: WEB,
      files: { "inventory/hosts.ini": ini({ web: WEB }), "inventory/group_vars/all.yml": USER, "inventory/host_vars/web-04.yml": "---\n# Copied from the bootstrap notes\nansible_user: root\n",
        "site.yml": "---\n- name: Check the web servers\n  hosts: web\n  tasks:\n    - name: Read the uptime\n      ansible.builtin.command: uptime\n      changed_when: false\n" },
      hints: [
        "Run `ansible web -m ping`. Which host fails, and which user does the error say Ansible logged in as?",
        "`ansible-inventory --host web-04` shows the variables Ansible uses for that host. Where does that ansible_user come from? A `-u deploy` on the command line is weaker than ansible_user in the inventory.",
        "Remove the override: `rm inventory/host_vars/web-04.yml` (or edit it), then `ansible web -m ping`."
      ],
      lesson: "The inventory set the login user for web-04 to root, which has no key there. Inventory variables beat -u, so the fix belongs in the inventory.",
      tries: ["ansible web -m ping", "ansible-inventory --host web-04"],
      won: (sim) => okOn(lastAny(sim), ["web-04"]) && !(lastAny(sim).opts.user) && !("ansible_user" in lastAny(sim).extra) && sim.resolve("web-04", "ansible_user") === "deploy",
      check: (sim) => fleetCheck("ssh to web-04", sim.resolve("web-04", "ansible_user") === "deploy", `logs in as ${sim.resolve("web-04", "ansible_user")}`)
    },
    {
      id: "timeout", title: "Connection timed out", level: "01",
      story: "The database replica db-02 drops out of every run with UNREACHABLE after a long wait. The cloud console says it is up.",
      goal: "Reach db-02 from Ansible.",
      error: "fatal: [db-02]: UNREACHABLE! => {\"changed\": false, \"msg\": \"Failed to connect to the host via ssh: ssh: connect to host 10.0.2.21 port 22: Connection timed out\", \"unreachable\": true}",
      hosts: [DB, { name: "db-02", ip: "10.0.2.12" }],
      files: { "inventory/hosts.ini": "[db]\ndb-01 ansible_host=10.0.2.11\ndb-02 ansible_host=10.0.2.21\n", "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Check the databases\n  hosts: db\n  tasks:\n    - name: Read the uptime\n      ansible.builtin.command: uptime\n      changed_when: false\n" },
      hints: [
        "Run `ansible db -m ping`. A timeout, not a refusal, means nothing answered at that address.",
        "Compare the address in the error with the console's: `ansible-inventory --host db-02`. The replica's real address is 10.0.2.12.",
        "Fix the typo: `sed -i 's/10.0.2.21/10.0.2.12/' inventory/hosts.ini`, then `ansible db -m ping`."
      ],
      lesson: "A timeout means the address does not answer: wrong IP, firewall or security group. A longer timeout only waits longer.",
      tries: ["ansible db -m ping", "ansible-inventory --host db-02"],
      won: (sim) => okOn(lastAny(sim), ["db-02"]) && sim.resolve("db-02", "ansible_host") === "10.0.2.12",
      check: (sim) => fleetCheck("db-02 address", sim.resolve("db-02", "ansible_host") === "10.0.2.12", `inventory says ${sim.resolve("db-02", "ansible_host")}`)
    },
    {
      id: "hostkey", title: "Host key changed after a rebuild", level: "02",
      story: "The platform team rebuilt web-03 from a fresh image last night. Now Ansible refuses to talk to it. They confirmed the rebuild in the change log.",
      goal: "Reach web-03 again, keeping host key checking on.",
      error: "fatal: [web-03]: UNREACHABLE! => {\"changed\": false, \"msg\": \"Failed to connect to the host via ssh: @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\\r\\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @ ... Host key verification failed.\", \"unreachable\": true}",
      hosts: WEB, oldKeys: { "web-03": "key-web-03-before-rebuild" },
      files: { "inventory/hosts.ini": ini({ web: WEB }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Check the web servers\n  hosts: web\n  tasks:\n    - name: Read the uptime\n      ansible.builtin.command: uptime\n      changed_when: false\n" },
      hints: [
        "Run `ansible web -m ping`. SSH stores each host's key in ~/.ssh/known_hosts and refuses a host whose key changed.",
        "The change is expected (a rebuild), so replace the one stale entry. Turning host_key_checking off would also hide a real attack.",
        "`ssh-keygen -R 10.0.1.13`, then `ssh-keyscan 10.0.1.13 >> ~/.ssh/known_hosts` (or `ssh deploy@10.0.1.13` and answer yes), then `ansible web -m ping`."
      ],
      lesson: "You replaced one known host key after confirming the rebuild, instead of switching off the check that protects every host.",
      tries: ["ansible web -m ping", "grep 10.0.1.13 ~/.ssh/known_hosts"],
      won: (sim) => okOn(lastAny(sim), ["web-03"]) && sim.cfgBool("host_key_checking", true) && !lastAny(sim).extra.ansible_ssh_common_args,
      check: (sim) => fleetCheck("host key checking", sim.cfgBool("host_key_checking", true), sim.cfgBool("host_key_checking", true) ? "on" : "off: every host is open to a man in the middle")
    },
    {
      id: "sudopass", title: "Missing sudo password", level: "02",
      story: "Two new web servers came from the platform team's image. On them, the deploy user needs a password for sudo, and the nginx play fails before it installs anything.",
      goal: "Install nginx on all four web servers. The deploy user's sudo password on the new hosts is practice-sudo.",
      error: "fatal: [web-03]: FAILED! => {\"msg\": \"Missing sudo password\"}",
      hosts: [web(1), web(2), web(3, { logins: { deploy: { keys: ["id_ed25519"], sudo: "password" } }, sudoPassword: "practice-sudo" }), web(4, { logins: { deploy: { keys: ["id_ed25519"], sudo: "password" } }, sudoPassword: "practice-sudo" })],
      files: { "inventory/hosts.ini": ini({ web: WEB }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Web servers\n  hosts: web\n  become: true\n  tasks:\n    - name: Install nginx\n      ansible.builtin.apt:\n        name: nginx\n        state: present\n" },
      hints: [
        "Run `ansible-playbook site.yml`. Which hosts fail, and at which task?",
        "`ssh deploy@10.0.1.13 sudo -n true` shows sudo asks for a password there. Ansible needs it to become root; dropping `become` makes apt fail instead.",
        "Ask for it at run time: `ansible-playbook site.yml -K` and type practice-sudo at the BECOME password prompt."
      ],
      lesson: "With -K Ansible sends the sudo password it needs. In automation, keep it in Vault as ansible_become_password instead of typing it.",
      tries: ["ansible-playbook site.yml", "ssh deploy@10.0.1.13 sudo -n true"],
      won: (sim) => okOn(last(sim), names(WEB)) && names(WEB).every((h) => sim.hosts[h].packages.nginx),
      check: (sim) => { const n = names(WEB).filter((h) => sim.hosts[h].packages.nginx).length; return fleetCheck("nginx installed", n === 4, count(n, 4, "hosts")); }
    },
    {
      id: "nohosts", title: "Play matched no hosts", level: "01",
      story: "The new message of the day was deployed an hour ago and the run was green. Nobody sees it when they log in.",
      goal: "Get the message onto all four web servers.",
      error: "[WARNING]: Could not match supplied host pattern, ignoring: webservers\n\nPLAY [Message of the day] ****\nskipping: no hosts matched",
      hosts: WEB,
      files: { "inventory/hosts.ini": ini({ web: WEB }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Message of the day\n  hosts: webservers\n  become: true\n  tasks:\n    - name: Write /etc/motd\n      ansible.builtin.copy:\n        content: \"Managed by Ansible. Changes made here are overwritten.\\n\"\n        dest: /etc/motd\n        mode: \"0644\"\n" },
      hints: [
        "Run `ansible-playbook site.yml` and read every line, warnings included. How many hosts are in the recap?",
        "`ansible-inventory --graph` lists the groups that exist. A play whose pattern matches nothing is skipped, and the run still exits 0. --limit cannot add hosts the play does not match.",
        "Point the play at the real group: `sed -i 's/hosts: webservers/hosts: web/' site.yml`, then run it again."
      ],
      lesson: "A host pattern that matches nothing only warns, so a green run can do nothing. Read warnings, and check the recap lists the hosts you expected.",
      tries: ["ansible-playbook site.yml", "ansible-inventory --graph"],
      won: (sim) => names(WEB).every((h) => /Managed by Ansible/.test(file(sim, h, "/etc/motd") || "")),
      check: (sim) => { const n = names(WEB).filter((h) => /Managed by Ansible/.test(file(sim, h, "/etc/motd") || "")).length; return fleetCheck("/etc/motd", n === 4, count(n, 4, "hosts")); }
    },
    {
      id: "limit", title: "--limit typo runs nothing", level: "11",
      story: "A security fix for openssl must go to the canary web-01 first and be watched for an hour. The on-call ran `ansible-playbook patch.yml --limit web01` and got an error.",
      goal: "Patch web-01 only. The other web servers must keep the old package until the canary has been watched.",
      error: "[WARNING]: Could not match supplied host pattern, ignoring: web01\nERROR! Specified inventory, host pattern and/or --limit leaves us with no hosts to target.",
      hosts: WEB.map((h) => ({ ...h, packages: { openssl: "3.0.13-0ubuntu3.1" } })),
      files: { "inventory/hosts.ini": ini({ web: WEB }), "inventory/group_vars/all.yml": USER,
        "patch.yml": "---\n- name: Security update for openssl\n  hosts: web\n  become: true\n  tasks:\n    - name: Install the fixed openssl\n      ansible.builtin.apt:\n        name: openssl=3.0.13-0ubuntu3.4\n        state: present\n" },
      hints: [
        "Run `ansible-playbook patch.yml --limit web01`. What does the warning say about web01?",
        "`ansible-inventory --graph` shows the real host names. A limit that is too wide (web, or web*) would patch every server at once, and that cannot be undone here.",
        "Preview first: `ansible-playbook patch.yml --limit web-01 --list-hosts`, then run `ansible-playbook patch.yml --limit web-01`."
      ],
      lesson: "--limit matched nothing, so Ansible stopped. `--list-hosts` shows what a limit selects before anything changes.",
      tries: ["ansible-playbook patch.yml --limit web01", "ansible-inventory --graph"],
      won: (sim) => sim.hosts["web-01"].packages.openssl === "3.0.13-0ubuntu3.4" && ["web-02", "web-03", "web-04"].every((h) => sim.hosts[h].packages.openssl === "3.0.13-0ubuntu3.1"),
      check: (sim) => {
        const patched = names(WEB).filter((h) => sim.hosts[h].packages.openssl === "3.0.13-0ubuntu3.4");
        const early = patched.filter((h) => h !== "web-01");
        return fleetCheck("openssl patched", patched.length === 1 && patched[0] === "web-01", early.length ? `${early.join(", ")} patched before the canary was watched: reset to try again` : patched.length ? "web-01 only" : "none yet");
      }
    },
    {
      id: "python", title: "No Python on the new host", level: "03",
      story: "edge-01 runs a minimal Debian image. The first run against it fails while gathering facts, before any task.",
      goal: "Run site.yml successfully on edge-01 and the existing edge-02.",
      error: "fatal: [edge-01]: FAILED! => {\"ansible_facts\": {}, \"changed\": false, \"failed_modules\": {\"ansible.legacy.setup\": {... \"module_stdout\": \"/bin/sh: 1: /usr/bin/python3: not found\\r\\n\", \"msg\": \"The module failed to execute correctly, you probably need to set the interpreter.\\nSee stdout/stderr for the exact error\", \"rc\": 127}}, \"msg\": \"The following modules failed to execute: ansible.legacy.setup\\n\"}",
      hosts: [{ name: "edge-01", ip: "10.0.3.11", os: "debian", python: null }, { name: "edge-02", ip: "10.0.3.12", os: "debian" }],
      files: { "inventory/hosts.ini": "[edge]\nedge-01 ansible_host=10.0.3.11\nedge-02 ansible_host=10.0.3.12\n", "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Edge nodes\n  hosts: edge\n  become: true\n  tasks:\n    - name: Install chrony\n      ansible.builtin.apt:\n        name: chrony\n        state: present\n" },
      hints: [
        "Run `ansible-playbook site.yml` and read edge-01's module_stdout: what is not found?",
        "Every module except raw runs Python on the host. Pointing ansible_python_interpreter at another path, or turning facts off, does not install Python.",
        "Bootstrap it with the raw module, which needs only SSH: `ansible edge-01 -m raw -a 'apt-get install -y python3' -b`, then run the playbook again."
      ],
      lesson: "Modules are Python programs run on the host. raw sends a plain command over SSH, which is how you install Python where it is missing.",
      tries: ["ansible-playbook site.yml", "ssh deploy@10.0.3.11 python3 --version"],
      won: (sim) => !!sim.hosts["edge-01"].python && okOn(last(sim), ["edge-01", "edge-02"]),
      check: (sim) => fleetCheck("python3 on edge-01", !!sim.hosts["edge-01"].python, sim.hosts["edge-01"].python ? "installed" : "missing")
    },

    // Playbooks and modules
    {
      id: "indent", title: "YAML indentation error", level: "04",
      story: "A teammate added a task to site.yml in a hurry. Now the playbook does not even start.",
      goal: "Get site.yml running: nginx installed and started on the web servers.",
      error: "ERROR! We were unable to read either as JSON nor YAML, these are the errors we got from each:\nJSON: Expecting value: line 1 column 1 (char 0)\n\nSyntax Error while loading YAML.\n  mapping values are not allowed in this context",
      hosts: WEB.slice(0, 2),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Web servers\n  hosts: web\n  become: true\n  tasks:\n    - name: Install nginx\n      ansible.builtin.apt:\n        name: nginx\n        state: present\n\n    - name: Start nginx\n        ansible.builtin.service:\n        name: nginx\n        state: started\n        enabled: true\n" },
      hints: [
        "`ansible-playbook site.yml --syntax-check` names the line and column, and points at the problem with ^ here.",
        "`cat -n site.yml`. In YAML a module must line up with `name:` of its task, and its options sit two spaces deeper.",
        "Line 12 is indented two spaces too far: `sed -i '12s/^        ansible/      ansible/' site.yml`, then `ansible-playbook site.yml`."
      ],
      lesson: "YAML structure is indentation. The caret in Ansible's error points at where the parser gave up; the mistake is often on that line or the one before.",
      tries: ["ansible-playbook site.yml --syntax-check", "cat -n site.yml"],
      won: (sim) => okOn(last(sim), ["web-01", "web-02"]) && ["web-01", "web-02"].every((h) => current(sim, h, "nginx")),
      check: (sim) => { let ok = true; try { L.parseYaml(sim.read("site.yml") || ""); } catch { ok = false; } return fleetCheck("site.yml parses", ok, ok ? "valid YAML" : "YAML error"); }
    },
    {
      id: "aptlock", title: "Could not get lock: apt is busy", level: "03",
      story: "Fresh web servers boot and start unattended-upgrades. The provisioning play runs a minute later and fails on every apt task.",
      goal: "Install nginx on both new web servers without damaging their package database.",
      error: "fatal: [web-01]: FAILED! => {\"changed\": false, \"msg\": \"Failed to lock apt for exclusive operation: Failed to lock directory /var/lib/apt/lists/: E:Could not get lock /var/lib/apt/lists/lock. It is held by process 2481 (apt-get)\"}",
      hosts: WEB.slice(0, 2).map((h) => ({ ...h, services: { "unattended-upgrades": {} } })),
      setup: (sim) => { for (const h of Object.values(sim.hosts)) h.aptLock = 300; },
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Web servers\n  hosts: web\n  become: true\n  tasks:\n    - name: Install nginx\n      ansible.builtin.apt:\n        name: nginx\n        state: present\n" },
      hints: [
        "Run `ansible-playbook site.yml`. Which process holds the lock? `ansible web -b -a 'systemctl status unattended-upgrades'`.",
        "Another apt is mid-upgrade. Deleting the lock file, or stopping that upgrade halfway, leaves dpkg half-configured. The apt module can wait instead: it waits 60 seconds by default, and this upgrade needs about five minutes.",
        "Let apt wait: add `lock_timeout: 600` under the apt options (`edit site.yml`), then `ansible-playbook site.yml`. If you broke dpkg, `reset`."
      ],
      lesson: "lock_timeout makes apt wait for the other package run to finish. Removing lock files never fixes contention; it corrupts the package database.",
      tries: ["ansible-playbook site.yml", "ansible web -b -a 'systemctl status unattended-upgrades'"],
      won: (sim) => ["web-01", "web-02"].every((h) => sim.hosts[h].packages.nginx && !sim.hosts[h].dpkgBroken),
      check: (sim) => { const broken = ["web-01", "web-02"].filter((h) => sim.hosts[h].dpkgBroken); return fleetCheck("package database", !broken.length, broken.length ? `dpkg interrupted on ${broken.join(", ")}: reset to try again` : "healthy"); }
    },
    {
      id: "param", title: "Unsupported parameters", level: "03",
      story: "A new task to install git fails on every host with a long list of parameter names.",
      goal: "Install git on both web servers.",
      error: "fatal: [web-01]: FAILED! => {\"changed\": false, \"msg\": \"Unsupported parameters for (ansible.builtin.apt) module: package_name. Supported parameters include: allow_change_held_packages, ...\"}",
      hosts: WEB.slice(0, 2),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Tools\n  hosts: web\n  become: true\n  tasks:\n    - name: Install git\n      ansible.builtin.apt:\n        package_name: git\n        state: present\n" },
      hints: [
        "Run `ansible-playbook site.yml`. The error names the parameter the module does not know.",
        "`ansible-doc ansible.builtin.apt` lists its options. Aliases are in brackets at the end of the error.",
        "Use `name` (or its alias `pkg`): `sed -i 's/package_name:/name:/' site.yml`, then run again."
      ],
      lesson: "Modules check their arguments before they run. ansible-doc is the offline reference for every option.",
      tries: ["ansible-playbook site.yml", "ansible-doc ansible.builtin.apt"],
      won: (sim) => ["web-01", "web-02"].every((h) => sim.hosts[h].packages.git) && okOn(last(sim), ["web-01", "web-02"]),
      check: (sim) => { const n = ["web-01", "web-02"].filter((h) => sim.hosts[h].packages.git).length; return fleetCheck("git installed", n === 2, count(n, 2, "hosts")); }
    },
    {
      id: "registerloop", title: "register in a loop", level: "06",
      story: "A report task should print the git and curl versions on each host. It fails on the debug task every time.",
      goal: "Get the version report to run on both hosts.",
      error: "fatal: [web-01]: FAILED! => {\"msg\": \"The task includes an option with an undefined variable. The error was: 'dict object' has no attribute 'stdout'. 'dict object' has no attribute 'stdout'...\"}",
      hosts: WEB.slice(0, 2).map((h) => ({ ...h, packages: { git: "1:2.43.0-1ubuntu7.1", curl: "8.5.0-2ubuntu10.4" } })),
      programs: { git: { run: () => ({ rc: 0, out: "git version 2.43.0\n", err: "" }) }, curl: { run: (sim, h, a) => (a.includes("--version") ? { rc: 0, out: "curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0\n", err: "" } : { rc: 7, out: "", err: "curl: (7) Failed to connect\n" }) } },
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "report.yml": "---\n- name: Tool versions\n  hosts: web\n  gather_facts: false\n  tasks:\n    - name: Read versions\n      ansible.builtin.command: \"{{ item }} --version\"\n      loop:\n        - git\n        - curl\n      register: versions\n      changed_when: false\n\n    - name: Show versions\n      ansible.builtin.debug:\n        msg: \"{{ versions.stdout }}\"\n" },
      hints: [
        "Run `ansible-playbook report.yml`, then look at what was registered: add a task `debug: var=versions`, or read the error closely.",
        "A registered loop holds one result per item in `versions.results`; it has no stdout of its own.",
        "Use the list: `sed -i \"s/versions.stdout }}/versions.results | map(attribute='stdout') | list }}/\" report.yml`, then run it."
      ],
      lesson: "register on a loop stores a list of results under .results. map(attribute=...) pulls one field from each.",
      tries: ["ansible-playbook report.yml", "cat report.yml"],
      won: (sim) => okOn(last(sim), ["web-01", "web-02"]) && /git version/.test(last(sim).output),
      check: (sim) => fleetCheck("version report", !!last(sim) && okOn(last(sim), ["web-01", "web-02"]), last(sim) ? (okOn(last(sim), ["web-01", "web-02"]) ? "ran" : "failed") : "not run")
    },
    {
      id: "copytemplate", title: "Literal {{ }} in a config file", level: "06",
      story: "After this morning's change the orders app will not start on the web servers. Its config file looks odd.",
      goal: "Get the app running and healthy on port 8080 on both web servers.",
      error: "fatal: [web-01]: FAILED! => {\"changed\": false, \"msg\": \"Unable to restart service app: Job for app.service failed because the control process exited with error code.\\nSee \\\"systemctl status app.service\\\" and \\\"journalctl -xeu app.service\\\" for details.\\n\"}",
      hosts: WEB.slice(0, 2).map((h) => {
        const x = app(h, "2.4", 8080, { files: { "/etc/app/app.conf": "port = {{ app_port }}\n" } });
        x.services = { app: { running: false } };
        return x;
      }),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER + "app_port: 8080\n",
        "site.yml": "---\n- name: Orders app\n  hosts: web\n  become: true\n  roles:\n    - app\n",
        "roles/app/tasks/main.yml": "---\n- name: Write the app config\n  ansible.builtin.copy:\n    src: app.conf.j2\n    dest: /etc/app/app.conf\n    mode: \"0644\"\n  notify: Restart app\n\n- name: Start the app\n  ansible.builtin.service:\n    name: app\n    state: started\n",
        "roles/app/handlers/main.yml": "---\n- name: Restart app\n  ansible.builtin.service:\n    name: app\n    state: restarted\n",
        "roles/app/files/app.conf.j2": "port = {{ app_port }}\n" },
      hints: [
        "`ansible web -a 'cat /etc/app/app.conf'`. Is that a value the app can read?",
        "copy sends a file as it is; only template renders Jinja. Restarting the service reads the same broken file.",
        "Move the file to templates and use the template module: `mkdir roles/app/templates && mv roles/app/files/app.conf.j2 roles/app/templates/`, `sed -i 's/ansible.builtin.copy:/ansible.builtin.template:/' roles/app/tasks/main.yml`, then run site.yml."
      ],
      lesson: "copy ships files byte for byte; template renders {{ }} with the host's variables. Put .j2 files in templates/ and use the template module.",
      tries: ["ansible web -a 'cat /etc/app/app.conf'", "cat roles/app/tasks/main.yml"],
      won: (sim) => ["web-01", "web-02"].every((h) => healthy(sim, h) && file(sim, h, "/etc/app/app.conf") === "port = 8080\n"),
      check: (sim) => { const n = ["web-01", "web-02"].filter((h) => healthy(sim, h)).length; return fleetCheck("app healthy", n === 2, count(n, 2, "hosts")); }
    },
    {
      id: "osfamily", title: "Package name differs by OS", level: "05",
      story: "The web role works on Ubuntu. web-02 is the first Rocky Linux server, and the role fails on it.",
      goal: "Run the web server on both hosts: apache2 on Ubuntu, httpd on Rocky.",
      error: "fatal: [web-02]: FAILED! => {\"changed\": false, \"failures\": [\"No package apache2 available.\"], \"msg\": \"Failed to install some of the specified packages\", \"rc\": 1, \"results\": []}",
      hosts: [web(1), web(2, { os: "rocky" })],
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Web servers\n  hosts: web\n  become: true\n  roles:\n    - web\n",
        "roles/web/tasks/main.yml": "---\n- name: Install the web server\n  ansible.builtin.package:\n    name: apache2\n    state: present\n\n- name: Start the web server\n  ansible.builtin.service:\n    name: apache2\n    state: started\n    enabled: true\n",
        "roles/web/vars/Debian.yml": "---\nweb_package: apache2\nweb_service: apache2\n",
        "roles/web/vars/RedHat.yml": "---\nweb_package: httpd\nweb_service: httpd\n" },
      hints: [
        "`ansible web -m setup -a 'filter=ansible_os_family'` shows each host's family. Which names does the role hard-code?",
        "The role already has vars/Debian.yml and vars/RedHat.yml. Skipping Rocky with `when` leaves web-02 without a web server.",
        "Add a first task `- ansible.builtin.include_vars: \"{{ ansible_facts['os_family'] }}.yml\"` to roles/web/tasks/main.yml and use `{{ web_package }}` and `{{ web_service }}` (`edit roles/web/tasks/main.yml`)."
      ],
      lesson: "Facts tell you the OS; include_vars loads the right names for it, so one role serves both families.",
      tries: ["ansible web -m setup -a 'filter=ansible_os_family'", "ls roles/web/vars"],
      won: (sim) => current(sim, "web-01", "apache2") && current(sim, "web-02", "httpd"),
      check: (sim) => { const n = [current(sim, "web-01", "apache2"), current(sim, "web-02", "httpd")].filter(Boolean).length; return fleetCheck("web server running", n === 2, count(n, 2, "hosts")); }
    },
    {
      id: "tagskip", title: "--tags skips a critical task", level: "11",
      story: "The pipeline deploys with `ansible-playbook deploy.yml --tags deploy`. After today's release 2.5, the health check fails on every web server.",
      goal: "Make the pipeline's command deploy 2.5 correctly: run `ansible-playbook deploy.yml --tags deploy` and see the health check pass.",
      error: "fatal: [web-01]: FAILED! => {\"changed\": false, ... \"msg\": \"Status code was 503 and not [200]: HTTP Error 503: Service Unavailable\", \"status\": 503, \"url\": \"http://localhost:8080/healthz\"}",
      hosts: WEB.map((h) => app(h, "2.4")), db: { schema: 41 },
      healthy: (sim, h) => !(String(h.files["/opt/app/VERSION"].content).trim() === "2.5" && sim.db.schema < 42),
      programs: { migrate: { run: (sim) => { if (sim.db.schema >= 42) return { rc: 0, out: "No migrations to apply.\n", err: "" }; sim.db.schema = 42; return { rc: 0, out: "Applying 0042_add_order_notes... OK\n", err: "" }; } } },
      files: { "inventory/hosts.ini": ini({ web: WEB }), "inventory/group_vars/all.yml": USER + "app_version: \"2.5\"\n",
        "deploy.yml": "---\n- name: Deploy the orders app\n  hosts: web\n  become: true\n  tasks:\n    - name: Install the release\n      ansible.builtin.copy:\n        content: \"{{ app_version }}\\n\"\n        dest: /opt/app/VERSION\n        mode: \"0644\"\n      tags: [deploy]\n\n    - name: Run database migrations\n      ansible.builtin.command: /opt/app/bin/migrate\n      run_once: true\n\n    - name: Restart the app\n      ansible.builtin.service:\n        name: app\n        state: restarted\n      tags: [deploy]\n\n    - name: Check health\n      ansible.builtin.uri:\n        url: http://localhost:8080/healthz\n      tags: [deploy]\n" },
      hints: [
        "`ansible-playbook deploy.yml --tags deploy --list-tasks` shows exactly which tasks that command runs.",
        "The migration has no tag, so --tags deploy skips it. Running without --tags would work today, but the pipeline would skip it again next release.",
        "Tag it: add `tags: [deploy]` (or `[always]`) to the migration task (`edit deploy.yml`), then `ansible-playbook deploy.yml --tags deploy`."
      ],
      lesson: "With --tags, untagged tasks are skipped silently. --list-tasks shows what a tag selects; tasks every deploy needs get the tag, or always.",
      tries: ["ansible-playbook deploy.yml --tags deploy --list-tasks", "ansible-playbook deploy.yml --tags deploy"],
      won: (sim) => {
        const t = tasksIn(parse(sim, "deploy.yml")).find((x) => /migrat/i.test(String(x.name || "")));
        const tags = t ? [].concat(t.tags || []).map(String) : [];
        return sim.db.schema >= 42 && names(WEB).every((h) => healthy(sim, h) && version(sim, h) === "2.5") && (tags.includes("deploy") || tags.includes("always"));
      },
      check: (sim) => fleetCheck("database schema", sim.db.schema >= 42, `version ${sim.db.schema}${sim.db.schema < 42 ? ", app 2.5 needs 42" : ""}`)
    },
    {
      id: "rescue", title: "A failed deploy leaves the app down", level: "12",
      story: "Release 3.0 failed halfway through its migration last night. The play had already stopped the app, so the failure became an outage until someone started it by hand.",
      goal: "Make deploy.yml leave the app running on 2.9 when a release fails. Prove it by deploying 3.0 (which still fails).",
      error: "fatal: [web-01]: FAILED! => {\"changed\": true, \"cmd\": [\"/opt/app/bin/migrate\"], ... \"msg\": \"non-zero return code\", \"rc\": 1, \"stderr\": \"migration 0043_split_addresses failed: column \\\"street\\\" already exists\"}",
      hosts: WEB.slice(0, 2).map((h) => app(h, "2.9")),
      healthy: (sim, h) => String(h.files["/opt/app/VERSION"].content).trim() !== "3.0",
      programs: { migrate: { run: (sim, h) => (String(h.files["/opt/app/VERSION"].content).trim() === "3.0" ? { rc: 1, out: "Applying 0043_split_addresses...\n", err: "migration 0043_split_addresses failed: column \"street\" already exists\n" } : { rc: 0, out: "No migrations to apply.\n", err: "" }) } },
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER + "app_version: \"3.0\"\nprevious_version: \"2.9\"\n",
        "deploy.yml": "---\n- name: Deploy the orders app\n  hosts: web\n  become: true\n  tasks:\n    - name: Stop the app\n      ansible.builtin.service:\n        name: app\n        state: stopped\n\n    - name: Install the release\n      ansible.builtin.copy:\n        content: \"{{ app_version }}\\n\"\n        dest: /opt/app/VERSION\n        mode: \"0644\"\n\n    - name: Run database migrations\n      ansible.builtin.command: /opt/app/bin/migrate\n\n    - name: Start the app\n      ansible.builtin.service:\n        name: app\n        state: started\n" },
      hints: [
        "Run `ansible-playbook deploy.yml` and then `ansible web -m uri -a url=http://localhost:8080/healthz`. Where does the play stop, and in what state is the app?",
        "ignore_errors would start 3.0 anyway, broken. A block can have a rescue (runs only when a task in the block fails) and always (runs either way).",
        "Wrap the release, migration and start tasks in `block:`, add `rescue:` with a copy of `{{ previous_version }}` to /opt/app/VERSION, and `always:` with a service task `state: started` (`edit deploy.yml`). Then `ansible-playbook deploy.yml`."
      ],
      lesson: "block, rescue and always turn a failed step into a rollback: the run still reports the failure, but the service is left running the last good release.",
      tries: ["ansible-playbook deploy.yml", "ansible web -m uri -a url=http://localhost:8080/healthz"],
      won: (sim) => { const r = last(sim); return !!r && !("app_version" in r.extra) && sim.resolve("web-01", "app_version", "deploy.yml") === "3.0" && Object.values(r.stats).some((s) => s.rescued > 0) && ["web-01", "web-02"].every((h) => healthy(sim, h) && version(sim, h) === "2.9"); },
      check: (sim) => { const n = ["web-01", "web-02"].filter((h) => healthy(sim, h)).length; return fleetCheck("app serving", n === 2, count(n, 2, "hosts")); }
    },

    // Variables and templates
    {
      id: "undefined", title: "Undefined variable", level: "05",
      story: "The nginx role has run on the web servers for a year. Today it was added to the api servers, and it fails there.",
      goal: "Run site.yml on web and api servers with no extra variables on the command line.",
      error: "fatal: [api-01]: FAILED! => {\"changed\": false, \"msg\": \"AnsibleUndefinedVariable: 'nginx_worker_connections' is undefined. 'nginx_worker_connections' is undefined\"}",
      hosts: [web(1), { name: "api-01", ip: "10.0.4.11" }],
      files: { "inventory/hosts.ini": "[web]\nweb-01 ansible_host=10.0.1.11\n\n[api]\napi-01 ansible_host=10.0.4.11\n", "inventory/group_vars/all.yml": USER, "inventory/group_vars/web.yml": "---\nnginx_worker_connections: 1024\n",
        "site.yml": "---\n- name: Web servers\n  hosts: web\n  become: true\n  roles:\n    - nginx\n\n- name: API servers\n  hosts: api\n  become: true\n  roles:\n    - nginx\n",
        "roles/nginx/tasks/main.yml": "---\n- name: Install nginx\n  ansible.builtin.apt:\n    name: nginx\n    state: present\n\n- name: Write nginx.conf\n  ansible.builtin.template:\n    src: nginx.conf.j2\n    dest: /etc/nginx/nginx.conf\n    mode: \"0644\"\n",
        "roles/nginx/templates/nginx.conf.j2": "user www-data;\nworker_processes auto;\nevents { worker_connections {{ nginx_worker_connections }}; }\nhttp { include /etc/nginx/conf.d/*.conf; }\n" },
      hints: [
        "Run `ansible-playbook site.yml`. Which host fails, and on which variable?",
        "`grep -r nginx_worker_connections inventory roles` shows where it is defined: only for the web group. -e would hide the gap for one run.",
        "Give the role a default: `mkdir roles/nginx/defaults && echo 'nginx_worker_connections: 1024' > roles/nginx/defaults/main.yml`, then run site.yml."
      ],
      lesson: "A role should carry defaults for every variable it uses, in defaults/main.yml; inventory then overrides them where needed.",
      tries: ["ansible-playbook site.yml", "ansible-inventory --host api-01"],
      won: (sim) => okOn(last(sim), ["web-01", "api-01"]) && !("nginx_worker_connections" in last(sim).extra) && /worker_connections \d+/.test(file(sim, "api-01", "/etc/nginx/nginx.conf") || ""),
      check: (sim) => fleetCheck("nginx.conf on api-01", /worker_connections \d+/.test(file(sim, "api-01", "/etc/nginx/nginx.conf") || ""), /worker_connections \d+/.test(file(sim, "api-01", "/etc/nginx/nginx.conf") || "") ? "rendered" : "not written")
    },
    {
      id: "hostvars", title: "One host stays on the old version", level: "05",
      story: "Release 2.4 went out to all four web servers this morning. Customers routed to web-02 still see 2.1 bugs, and every run says web-02 is ok.",
      goal: "Run 2.4 on all four web servers, with the inventory saying so.",
      error: "TASK [Install the release] ****\nchanged: [web-01]\nok: [web-02]\nchanged: [web-03]\nchanged: [web-04]",
      hosts: WEB.map((h) => app(h, h.name === "web-02" ? "2.1" : "2.3")),
      files: { "inventory/hosts.ini": ini({ web: WEB }), "inventory/group_vars/all.yml": USER, "inventory/group_vars/web.yml": "---\napp_version: \"2.4\"\n",
        "inventory/host_vars/web-02.yml": "---\n# Pinned during the March incident (INC-2291). Remove when fixed.\napp_version: \"2.1\"\n",
        "deploy.yml": "---\n- name: Deploy the orders app\n  hosts: web\n  become: true\n  tasks:\n    - name: Install the release\n      ansible.builtin.copy:\n        content: \"{{ app_version }}\\n\"\n        dest: /opt/app/VERSION\n        mode: \"0644\"\n" },
      hints: [
        "Compare `ansible-inventory --host web-01` with `ansible-inventory --host web-02`. Which app_version does each get?",
        "host_vars beat group_vars. Changing group_vars again, or group_vars/all, cannot win over a host's own value; -e would fix only this run.",
        "Remove the stale pin: `rm inventory/host_vars/web-02.yml`, then `ansible-playbook deploy.yml`."
      ],
      lesson: "Variable precedence: a host's own variables beat its groups'. Temporary pins in host_vars outlive their incident unless someone removes them.",
      tries: ["ansible-inventory --host web-02", "ansible web -a 'cat /opt/app/VERSION'"],
      won: (sim) => names(WEB).every((h) => version(sim, h) === "2.4") && sim.resolve("web-02", "app_version", "deploy.yml") === "2.4",
      check: (sim) => { const n = names(WEB).filter((h) => version(sim, h) === "2.4").length; return fleetCheck("running 2.4", n === 4, count(n, 4, "hosts")); }
    },
    {
      id: "quotes", title: "Unquoted Jinja breaks YAML", level: "06",
      story: "A small playbook to create the app directory fails before it starts, with a hint about quotes.",
      goal: "Create /opt/orders/releases on both web servers.",
      error: "Syntax Error while loading YAML.\n  found unacceptable key (unhashable type: 'AnsibleMapping')\n...\nWe could be wrong, but this one looks like it might be an issue with\nmissing quotes. Always quote template expression brackets when they\nstart a value.",
      hosts: WEB.slice(0, 2),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER + "app_dir: /opt/orders\n",
        "site.yml": "---\n- name: App directories\n  hosts: web\n  become: true\n  tasks:\n    - name: Create the releases directory\n      ansible.builtin.file:\n        path: {{ app_dir }}/releases\n        state: directory\n        mode: \"0755\"\n" },
      hints: [
        "`ansible-playbook site.yml --syntax-check`. Read the hint at the end of the error.",
        "In YAML, a value starting with { is a dictionary. A value that starts with {{ must be quoted.",
        "`sed -i 's|path: {{ app_dir }}/releases|path: \"{{ app_dir }}/releases\"|' site.yml`, then run it."
      ],
      lesson: "Quote any YAML value that starts with {{. Ansible's error even suggests it.",
      tries: ["ansible-playbook site.yml --syntax-check", "cat -n site.yml"],
      won: (sim) => okOn(last(sim), ["web-01", "web-02"]) && ["web-01", "web-02"].every((h) => sim.hosts[h].dirs.has("/opt/orders/releases")),
      check: (sim) => { const n = ["web-01", "web-02"].filter((h) => sim.hosts[h].dirs.has("/opt/orders/releases")).length; return fleetCheck("/opt/orders/releases", n === 2, count(n, 2, "hosts")); }
    },
    {
      id: "stringfalse", title: "when is always true", level: "06",
      story: "Production servers should not get debugging tools. CI runs `ansible-playbook site.yml -e install_debug_tools=false`, yet strace and tcpdump appear on every server.",
      goal: "Make the CI command skip the debugging tools: run `ansible-playbook site.yml -e install_debug_tools=false` and see that task skipped on every host.",
      error: "TASK [Install debugging tools] ****\nchanged: [web-01]\nchanged: [web-02]",
      hosts: WEB.slice(0, 2),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER + "install_debug_tools: true\n",
        "site.yml": "---\n- name: Base packages\n  hosts: web\n  become: true\n  tasks:\n    - name: Install debugging tools\n      ansible.builtin.apt:\n        name: [strace, tcpdump]\n        state: present\n      when: install_debug_tools\n" },
      hints: [
        "`ansible-playbook site.yml -e install_debug_tools=false -v`. A skipped task would print skipping and the false condition.",
        "Variables from -e key=value are always strings, and the string \"false\" is not empty, so it is true. -e install_debug_tools=False or =no are strings too.",
        "Convert it in the condition: `sed -i 's/when: install_debug_tools$/when: install_debug_tools | bool/' site.yml`, then run the CI command again."
      ],
      lesson: "key=value extra vars are strings. Filter with | bool wherever a variable from the command line or a template feeds a condition.",
      tries: ["ansible-playbook site.yml -e install_debug_tools=false", "ansible web -m debug -a 'var=install_debug_tools' -e install_debug_tools=false"],
      won: (sim) => { const r = last(sim); const t = r && r.tasks.find((x) => x.title === "Install debugging tools"); return !!t && r.extra.install_debug_tools === "false" && ["web-01", "web-02"].every((h) => t.results[h] === "skipped") && okOn(r, ["web-01", "web-02"]); },
      check: (sim) => { const n = ["web-01", "web-02"].filter((h) => sim.hosts[h].packages.strace).length; return fleetCheck("debugging tools", n === 0, n ? `installed on ${n} hosts` : "not installed"); }
    },
    {
      id: "loopdict", title: "Looping over a dictionary", level: "06",
      story: "A new task should create the team's accounts from a dictionary in group_vars. It fails before creating anyone.",
      goal: "Create alice (with /bin/bash) and bob (with /bin/zsh) on both web servers.",
      error: "fatal: [web-01]: FAILED! => {\"msg\": \"Invalid data passed to 'loop', it requires a list, got this instead: {'alice': {'shell': '/bin/bash'}, 'bob': {'shell': '/bin/zsh'}}. Hint: If you passed a list/dict of just one element, try adding wantlist=True to your lookup invocation or use q/query instead of lookup.\"}",
      hosts: WEB.slice(0, 2),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER + "team:\n  alice:\n    shell: /bin/bash\n  bob:\n    shell: /bin/zsh\n",
        "users.yml": "---\n- name: Team accounts\n  hosts: web\n  become: true\n  tasks:\n    - name: Create accounts\n      ansible.builtin.user:\n        name: \"{{ item.key }}\"\n        shell: \"{{ item.value.shell }}\"\n      loop: \"{{ team }}\"\n" },
      hints: [
        "Run `ansible-playbook users.yml`. What type does loop say it needs, and what did it get?",
        "`with_items` over a dictionary does not give key and value either. The dict2items filter turns a dictionary into a list of {key, value} items.",
        "`sed -i 's/loop: \"{{ team }}\"/loop: \"{{ team | dict2items }}\"/' users.yml`, then run it."
      ],
      lesson: "loop needs a list. dict2items converts a dictionary into items with .key and .value.",
      tries: ["ansible-playbook users.yml", "ansible web -m debug -a 'var=team'"],
      won: (sim) => ["web-01", "web-02"].every((h) => (sim.hosts[h].accounts.alice || {}).shell === "/bin/bash" && (sim.hosts[h].accounts.bob || {}).shell === "/bin/zsh"),
      check: (sim) => { const n = ["web-01", "web-02"].filter((h) => sim.hosts[h].accounts.alice && sim.hosts[h].accounts.bob).length; return fleetCheck("accounts", n === 2, count(n, 2, "hosts")); }
    },
    {
      id: "hostvarsfacts", title: "Facts of other hosts are missing", level: "12",
      story: "The load balancer play builds haproxy.cfg from every web server's IP address. It fails as soon as it renders the template.",
      goal: "Write haproxy.cfg on lb-01 with all four web servers and their addresses, and run haproxy with it.",
      error: "fatal: [lb-01]: FAILED! => {\"changed\": false, \"msg\": \"AnsibleUndefinedVariable: 'ansible.vars.hostvars.HostVarsVars object' has no attribute 'ansible_default_ipv4'. 'ansible.vars.hostvars.HostVarsVars object' has no attribute 'ansible_default_ipv4'\"}",
      hosts: [...WEB, { ...LB, packages: { haproxy: "2.8.5-1ubuntu3.1" }, services: { haproxy: {} } }],
      files: { "inventory/hosts.ini": ini({ web: WEB, lb: [LB] }), "inventory/group_vars/all.yml": USER,
        "lb.yml": "---\n- name: Load balancer\n  hosts: lb\n  become: true\n  tasks:\n    - name: Write haproxy.cfg\n      ansible.builtin.template:\n        src: haproxy.cfg.j2\n        dest: /etc/haproxy/haproxy.cfg\n        mode: \"0644\"\n      notify: Reload haproxy\n  handlers:\n    - name: Reload haproxy\n      ansible.builtin.service:\n        name: haproxy\n        state: reloaded\n",
        "templates/haproxy.cfg.j2": "global\n    daemon\ndefaults\n    mode http\nbackend web\n{% for h in groups['web'] %}\n    server {{ h }} {{ hostvars[h]['ansible_default_ipv4']['address'] }}:8080 check\n{% endfor %}\n" },
      hints: [
        "Run `ansible-playbook lb.yml`. Whose facts does the template read, and which hosts did this run gather facts from?",
        "Facts exist only for hosts a run has gathered from (or a fact cache). This play touches only lb-01.",
        "Gather from the web servers first: add a play at the top of lb.yml: `- hosts: web` with `gather_facts: true` and `tasks: []` (`edit lb.yml`), then run it."
      ],
      lesson: "hostvars holds another host's facts only after a play gathered them in the same run. Gather first, or use inventory values such as ansible_host.",
      tries: ["ansible-playbook lb.yml", "cat templates/haproxy.cfg.j2"],
      won: (sim) => { const c = file(sim, "lb-01", "/etc/haproxy/haproxy.cfg") || ""; return WEB.every((h) => c.includes(`server ${h.name} ${h.ip}:8080`)) && current(sim, "lb-01", "haproxy"); },
      check: (sim) => { const c = file(sim, "lb-01", "/etc/haproxy/haproxy.cfg") || ""; const n = WEB.filter((h) => c.includes(`server ${h.name} ${h.ip}`)).length; return fleetCheck("haproxy backends", n === 4, count(n, 4, "servers")); }
    },

    // Roles and collections
    {
      id: "collection", title: "couldn't resolve module/action", level: "09",
      story: "The firewall play works on Priya's laptop. In CI it fails before the first play starts.",
      goal: "Make the play work from a fresh checkout: the collection listed in requirements.yml, installed from it, and the play run.",
      error: "ERROR! couldn't resolve module/action 'community.general.ufw'. This often indicates a misspelling, missing collection, or incorrect module path.",
      hosts: WEB.slice(0, 2).map((h) => ({ ...h, packages: { ufw: "0.36.2-6" } })),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER, "requirements.yml": "---\ncollections: []\n",
        "firewall.yml": "---\n- name: Firewall\n  hosts: web\n  become: true\n  tasks:\n    - name: Allow HTTPS\n      community.general.ufw:\n        rule: allow\n        port: \"443\"\n        proto: tcp\n" },
      hints: [
        "`ansible-galaxy collection list` shows what this machine has. community.general is not part of ansible-core.",
        "Installing it by hand fixes only this machine; CI installs what requirements.yml lists. Renaming the module to ufw does not help: the short name still lives in community.general.",
        "`edit requirements.yml` to list `- name: community.general` under collections, then `ansible-galaxy collection install -r requirements.yml` and `ansible-playbook firewall.yml`."
      ],
      lesson: "Collections are dependencies. List them in requirements.yml, pinned, and install from it everywhere, CI included.",
      tries: ["ansible-playbook firewall.yml", "ansible-galaxy collection list"],
      won: (sim) => { const req = parse(sim, "requirements.yml"); const listed = L.isDict(req) && [].concat(req.collections || []).some((c) => (L.isDict(c) ? c.name : String(c).split(":")[0]) === "community.general"); return listed && !!sim.collections["community.general"] && okOn(last(sim), ["web-01", "web-02"]); },
      check: (sim) => fleetCheck("community.general", !!sim.collections["community.general"], sim.collections["community.general"] ? `installed ${sim.collections["community.general"]}` : "not installed")
    },
    {
      id: "rolevars", title: "Role vars beat the inventory", level: "08",
      story: "The web servers must move nginx to port 8080. group_vars/web.yml says nginx_port: 8080, the run is green, and nginx still listens on 80.",
      goal: "Have nginx listen on 8080 on both web servers, with the inventory in control of the port.",
      error: "TASK [nginx : Write the site config] ****\nok: [web-01]\nok: [web-02]",
      hosts: WEB.slice(0, 2).map((h) => ({ ...h, packages: { nginx: "1.24.0-2ubuntu7.1" }, files: { "/etc/nginx/conf.d/site.conf": "server { listen 80; }\n" }, services: { nginx: {} } })),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER, "inventory/group_vars/web.yml": "---\nnginx_port: 8080\n",
        "site.yml": "---\n- name: Web servers\n  hosts: web\n  become: true\n  roles:\n    - nginx\n",
        "roles/nginx/vars/main.yml": "---\nnginx_port: 80\n",
        "roles/nginx/tasks/main.yml": "---\n- name: Write the site config\n  ansible.builtin.template:\n    src: site.conf.j2\n    dest: /etc/nginx/conf.d/site.conf\n    mode: \"0644\"\n  notify: Reload nginx\n",
        "roles/nginx/handlers/main.yml": "---\n- name: Reload nginx\n  ansible.builtin.service:\n    name: nginx\n    state: reloaded\n",
        "roles/nginx/templates/site.conf.j2": "server { listen {{ nginx_port }}; }\n" },
      hints: [
        "`ansible web -m debug -a var=nginx_port` shows 8080, yet the role renders 80. Where else is nginx_port set? `grep -r nginx_port .`",
        "Role vars/ sit high in precedence, above every inventory variable. Role defaults/ sit at the bottom, which is where a role's tunables belong.",
        "Move them: `mv roles/nginx/vars roles/nginx/defaults`, then `ansible-playbook site.yml`."
      ],
      lesson: "A role's vars/main.yml overrides the inventory; defaults/main.yml is overridden by it. Put anything users may change in defaults.",
      tries: ["ansible-playbook site.yml", "grep -r nginx_port roles inventory"],
      won: (sim) => ["web-01", "web-02"].every((h) => /listen 8080/.test(file(sim, h, "/etc/nginx/conf.d/site.conf") || "") && current(sim, h, "nginx")) && sim.resolve("web-01", "nginx_port") === 8080,
      check: (sim) => { const n = ["web-01", "web-02"].filter((h) => /listen 8080/.test(file(sim, h, "/etc/nginx/conf.d/site.conf") || "")).length; return fleetCheck("nginx on 8080", n === 2, count(n, 2, "hosts")); }
    },
    {
      id: "roledir", title: "A role that does nothing", level: "08",
      story: "A new nginx role was written and added to site.yml. The run is green, with only Gathering Facts in it, and nginx is not installed anywhere.",
      goal: "Install and start nginx on both web servers with the role.",
      error: "PLAY [Web servers] ****\n\nTASK [Gathering Facts] ****\nok: [web-01]\nok: [web-02]\n\nPLAY RECAP ****",
      hosts: WEB.slice(0, 2),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Web servers\n  hosts: web\n  become: true\n  roles:\n    - nginx\n",
        "roles/nginx/task/main.yml": "---\n- name: Install nginx\n  ansible.builtin.apt:\n    name: nginx\n    state: present\n\n- name: Start nginx\n  ansible.builtin.service:\n    name: nginx\n    state: started\n    enabled: true\n" },
      hints: [
        "`ansible-playbook site.yml --list-tasks`. Which tasks does Ansible see in the role?",
        "`tree roles`. Ansible reads a role's tasks from tasks/main.yml exactly; any other directory name is ignored without a warning.",
        "`mv roles/nginx/task roles/nginx/tasks`, then `ansible-playbook site.yml`."
      ],
      lesson: "Role directories have fixed names: tasks, handlers, defaults, vars, templates, files, meta. ansible-galaxy role init creates them for you.",
      tries: ["ansible-playbook site.yml --list-tasks", "tree roles"],
      won: (sim) => ["web-01", "web-02"].every((h) => current(sim, h, "nginx")),
      check: (sim) => { const n = ["web-01", "web-02"].filter((h) => current(sim, h, "nginx")).length; return fleetCheck("nginx running", n === 2, count(n, 2, "hosts")); }
    },
    {
      id: "rolemissing", title: "The role was not found", level: "09",
      story: "A new engineer cloned the repository and ran site.yml. It stops before the first play.",
      goal: "Install the roles the project needs and run site.yml.",
      error: "ERROR! the role 'baseline' was not found in /home/ops/project/roles:/home/ops/project/roles:/home/ops/project",
      hosts: WEB.slice(0, 2),
      galaxyRoles: { "https://git.example.com/platform/ansible-role-baseline.git": { files: { "tasks/main.yml": "---\n- name: Harden sshd\n  ansible.builtin.copy:\n    content: \"PasswordAuthentication no\\nPermitRootLogin no\\n\"\n    dest: /etc/ssh/sshd_config.d/50-baseline.conf\n    mode: \"0644\"\n", "meta/main.yml": "---\ngalaxy_info:\n  role_name: baseline\n" } } },
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "requirements.yml": "---\nroles:\n  - name: baseline\n    src: https://git.example.com/platform/ansible-role-baseline.git\n    version: v1.4.0\ncollections: []\n",
        "site.yml": "---\n- name: Baseline\n  hosts: web\n  become: true\n  roles:\n    - baseline\n" },
      hints: [
        "Run `ansible-playbook site.yml`. The error lists every directory Ansible searched.",
        "`cat requirements.yml`. Roles from other repositories are installed, not committed. `ansible-galaxy install baseline` looks on Galaxy, where this role is not.",
        "`ansible-galaxy install -r requirements.yml`, then `ansible-playbook site.yml`."
      ],
      lesson: "requirements.yml records where each role and collection comes from and which version; ansible-galaxy install -r fetches them all.",
      tries: ["ansible-playbook site.yml", "cat requirements.yml"],
      won: (sim) => okOn(last(sim), ["web-01", "web-02"]) && ["web-01", "web-02"].every((h) => file(sim, h, "/etc/ssh/sshd_config.d/50-baseline.conf")),
      check: (sim) => fleetCheck("role baseline", sim.isDir("roles/baseline"), sim.isDir("roles/baseline") ? "installed" : "not installed")
    },

    // Idempotency and handlers
    {
      id: "shell", title: "Changed on every run", level: "07",
      story: "Every run reports changed=1 on every host, so nobody notices real changes any more. On some hosts /etc/hosts has grown a duplicate line per run.",
      goal: "Make the task report ok when nothing needs doing: run the play and get changed=0 with the database entry in /etc/hosts.",
      error: "TASK [Add the database to /etc/hosts] ****\nchanged: [web-01]\nchanged: [web-02]\n...\nweb-01 : ok=2    changed=1",
      hosts: WEB.slice(0, 2).map((h) => ({ ...h, files: { "/etc/hosts": "127.0.0.1 localhost\n10.0.2.11 db.internal\n" } })),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Host entries\n  hosts: web\n  become: true\n  tasks:\n    - name: Add the database to /etc/hosts\n      ansible.builtin.shell: echo \"10.0.2.11 db.internal\" >> /etc/hosts\n" },
      hints: [
        "Run `ansible-playbook site.yml` twice, then `ansible web -a 'grep -c db.internal /etc/hosts'`.",
        "shell cannot know whether its work is already done. changed_when: false hides the report but still appends a line on every run.",
        "Use a module that checks first: replace the shell line with `ansible.builtin.lineinfile:` and `path: /etc/hosts`, `line: \"10.0.2.11 db.internal\"` (`edit site.yml`), then run twice."
      ],
      lesson: "lineinfile describes the state you want and changes nothing when it is already true. That is idempotency, and it makes changed mean something.",
      tries: ["ansible-playbook site.yml", "ansible web -a 'grep -c db.internal /etc/hosts'"],
      won: (sim) => { const r = last(sim); const t = tasksIn(parse(sim, "site.yml")); return okOn(r, ["web-01", "web-02"]) && changedTotal(r) === 0 && !t.some((x) => x["ansible.builtin.shell"] || x.shell || x["ansible.builtin.command"] || x.command) && ["web-01", "web-02"].every((h) => /10\.0\.2\.11 db\.internal/.test(file(sim, h, "/etc/hosts"))); },
      check: (sim) => { const n = Math.max(...["web-01", "web-02"].map((h) => (file(sim, h, "/etc/hosts").match(/db\.internal/g) || []).length)); return fleetCheck("db.internal lines", n === 1, `${n} in /etc/hosts`); }
    },
    {
      id: "changedwhen", title: "A check restarts the app every run", level: "07",
      story: "Every deploy restarts the orders app, even when nothing changed, and customers see errors for a few seconds each time.",
      goal: "Run the play twice; the second run must report changed=0 and leave the app alone.",
      error: "TASK [app : Check the config] ****\nchanged: [web-01]\n...\nRUNNING HANDLER [app : Restart app] ****\nchanged: [web-01]",
      hosts: WEB.slice(0, 2).map((h) => app(h)),
      programs: { "app-ctl": { run: () => ({ rc: 0, out: "config ok: /etc/app/app.conf\n", err: "" }) } },
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Orders app\n  hosts: web\n  become: true\n  roles:\n    - app\n",
        "roles/app/tasks/main.yml": "---\n- name: Write the app config\n  ansible.builtin.copy:\n    content: \"port = 8080\\n\"\n    dest: /etc/app/app.conf\n    mode: \"0644\"\n  notify: Restart app\n\n- name: Check the config\n  ansible.builtin.command: /opt/app/bin/app-ctl check-config\n  notify: Restart app\n",
        "roles/app/handlers/main.yml": "---\n- name: Restart app\n  ansible.builtin.service:\n    name: app\n    state: restarted\n" },
      hints: [
        "Run `ansible-playbook site.yml` twice. Which task reports changed the second time, and what does it notify?",
        "command always reports changed, because Ansible cannot tell what a command did. Removing the notify still leaves changed=1.",
        "The check only reads: add `changed_when: false` to that task and remove its notify (`edit roles/app/tasks/main.yml`), then run twice."
      ],
      lesson: "A read-only command needs changed_when: false. A false changed is not harmless: it fires handlers.",
      tries: ["ansible-playbook site.yml", "cat roles/app/tasks/main.yml"],
      won: (sim) => { const rs = runs(sim); const r = rs[rs.length - 1]; return rs.length >= 2 && okOn(r, ["web-01", "web-02"]) && changedTotal(r) === 0 && ["web-01", "web-02"].every((h) => healthy(sim, h)); },
      check: (sim) => { const r = last(sim); return fleetCheck("last run", !!r && changedTotal(r) === 0, r ? `changed=${changedTotal(r)}` : "not run"); }
    },
    {
      id: "handlernever", title: "Handler never fired", level: "07",
      story: "Yesterday's run changed nginx.conf (worker_connections 4096) and then failed on a later task. Today's runs are green, but nginx still runs with the old settings.",
      goal: "Get nginx on both web servers running the configuration that is on disk.",
      error: "TASK [Write nginx.conf] ****\nok: [web-01]\nok: [web-02]\n(no RUNNING HANDLER line)",
      hosts: WEB.slice(0, 2).map((h) => ({ ...h, packages: { nginx: "1.24.0-2ubuntu7.1" }, files: { "/etc/nginx/nginx.conf": "user www-data;\nworker_processes auto;\nevents { worker_connections 4096; }\nhttp { include /etc/nginx/conf.d/*.conf; }\n" }, services: { nginx: { stale: true } } })),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Web servers\n  hosts: web\n  become: true\n  tasks:\n    - name: Write nginx.conf\n      ansible.builtin.copy:\n        content: \"user www-data;\\nworker_processes auto;\\nevents { worker_connections 4096; }\\nhttp { include /etc/nginx/conf.d/*.conf; }\\n\"\n        dest: /etc/nginx/nginx.conf\n        mode: \"0644\"\n      notify: Reload nginx\n  handlers:\n    - name: Reload nginx\n      ansible.builtin.service:\n        name: nginx\n        state: reloaded\n" },
      hints: [
        "Run `ansible-playbook site.yml`. Does the config task report changed? Handlers run only when a task reports changed.",
        "Yesterday the change happened and the run failed before handlers ran. Today the file already matches, so nothing notifies. Running the play again never helps.",
        "Reload once by hand: `ansible web -m service -a 'name=nginx state=reloaded' -b`. To prevent it, set `force_handlers: true` on the play."
      ],
      lesson: "A failed run drops its notified handlers. Reload once by hand, and use force_handlers so notified handlers run even when a later task fails.",
      tries: ["ansible-playbook site.yml", "ansible web -a 'systemctl status nginx'"],
      won: (sim) => ["web-01", "web-02"].every((h) => current(sim, h, "nginx")),
      check: (sim) => { const n = ["web-01", "web-02"].filter((h) => current(sim, h, "nginx")).length; return fleetCheck("nginx config loaded", n === 2, count(n, 2, "hosts")); }
    },
    {
      id: "handlername", title: "Handler not found", level: "07",
      story: "A new log format for nginx is ready. The play changes the file on both hosts and then stops with an error about a handler.",
      goal: "Deploy the log format and have nginx reload it on both web servers.",
      error: "ERROR! The requested handler 'reload nginx' was not found in either the main handlers list nor in the listening handlers list",
      hosts: WEB.slice(0, 2).map((h) => ({ ...h, packages: { nginx: "1.24.0-2ubuntu7.1" }, services: { nginx: {} } })),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Web servers\n  hosts: web\n  become: true\n  tasks:\n    - name: Log format\n      ansible.builtin.copy:\n        content: \"log_format main '$remote_addr $request $status $request_time';\\n\"\n        dest: /etc/nginx/conf.d/log-format.conf\n        mode: \"0644\"\n      notify: reload nginx\n  handlers:\n    - name: Reload nginx\n      ansible.builtin.service:\n        name: nginx\n        state: reloaded\n" },
      hints: [
        "Run `ansible-playbook site.yml` and compare the name in the error with the handler's name.",
        "Handler names match exactly, capital letters included. The file was already changed by the failed run, so the next run will not notify at all.",
        "`sed -i 's/notify: reload nginx/notify: Reload nginx/' site.yml`. If the file is already in place, reload once: `ansible web -m service -a 'name=nginx state=reloaded' -b`."
      ],
      lesson: "notify must match a handler's name (or listen) exactly. A run that fails after a change leaves the reload to you.",
      tries: ["ansible-playbook site.yml", "grep -n -i 'reload nginx' site.yml"],
      won: (sim) => ["web-01", "web-02"].every((h) => file(sim, h, "/etc/nginx/conf.d/log-format.conf") && current(sim, h, "nginx")),
      check: (sim) => { const n = ["web-01", "web-02"].filter((h) => file(sim, h, "/etc/nginx/conf.d/log-format.conf") && current(sim, h, "nginx")).length; return fleetCheck("log format live", n === 2, count(n, 2, "hosts")); }
    },
    {
      id: "flush", title: "Handler runs too late", level: "07",
      story: "The app moves from port 8080 to 8081. The play writes the new config, then checks health on 8081, and fails there every time.",
      goal: "Move the app to 8081 on both hosts with a passing health check, then run again and get changed=0.",
      error: "fatal: [web-01]: FAILED! => {\"changed\": false, \"elapsed\": 0, \"msg\": \"Status code was -1 and not [200]: Request failed: <urlopen error [Errno 111] Connection refused>\", \"redirected\": false, \"status\": -1, \"url\": \"http://localhost:8081/healthz\"}",
      hosts: WEB.slice(0, 2).map((h) => app(h)),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER + "app_port: 8081\n",
        "site.yml": "---\n- name: Orders app\n  hosts: web\n  become: true\n  tasks:\n    - name: Write the app config\n      ansible.builtin.copy:\n        content: \"port = {{ app_port }}\\n\"\n        dest: /etc/app/app.conf\n        mode: \"0644\"\n      notify: Restart app\n\n    - name: Check health on the new port\n      ansible.builtin.uri:\n        url: \"http://localhost:{{ app_port }}/healthz\"\n  handlers:\n    - name: Restart app\n      ansible.builtin.service:\n        name: app\n        state: restarted\n" },
      hints: [
        "Run `ansible-playbook site.yml`. When do handlers run, compared with the health check?",
        "Handlers wait for the end of the play. A restart task with state: restarted would restart on every run, so the second run would not be changed=0.",
        "Run the queued handlers before the check: add `- ansible.builtin.meta: flush_handlers` as a task between the two (`edit site.yml`). The first run left the handler unrun, so restart once with `ansible web -m service -a 'name=app state=restarted' -b` if needed, then run the play twice."
      ],
      lesson: "meta: flush_handlers runs notified handlers at that point in the play, so later tasks see the change.",
      tries: ["ansible-playbook site.yml", "ansible web -a 'cat /etc/app/app.conf'"],
      won: (sim) => { const rs = runs(sim); const r = rs[rs.length - 1]; return rs.length >= 2 && okOn(r, ["web-01", "web-02"]) && changedTotal(r) === 0 && ["web-01", "web-02"].every((h) => Number(confLine(svc(sim, h, "app").loaded, "port")) === 8081); },
      check: (sim) => { const n = ["web-01", "web-02"].filter((h) => svc(sim, h, "app").running && Number(confLine(svc(sim, h, "app").loaded, "port")) === 8081).length; return fleetCheck("app on 8081", n === 2, count(n, 2, "hosts")); }
    },
    {
      id: "checkmode", title: "Check mode shows nothing", level: "11",
      story: "Tonight's change raises max_connections on the databases. The change board asked for a --check --diff preview, and it shows no changes at all, so they will not approve it.",
      goal: "Produce a --check --diff run that shows the max_connections change on both databases, without changing them.",
      error: "TASK [Raise max_connections] ****\nskipping: [db-01]\nskipping: [db-02]",
      hosts: [DB, { name: "db-02", ip: "10.0.2.12" }].map((h) => ({ ...h, files: { "/etc/postgresql/16/main/postgresql.conf": "listen_addresses = '*'\nmax_connections = 100\nshared_buffers = 1GB\n" } })),
      files: { "inventory/hosts.ini": "[db]\ndb-01 ansible_host=10.0.2.11\ndb-02 ansible_host=10.0.2.12\n", "inventory/group_vars/all.yml": USER,
        "db.yml": "---\n- name: Databases\n  hosts: db\n  become: true\n  tasks:\n    - name: Raise max_connections\n      ansible.builtin.shell: sed -i 's/^max_connections.*/max_connections = 500/' /etc/postgresql/16/main/postgresql.conf\n" },
      hints: [
        "Run `ansible-playbook db.yml --check --diff -v`. What does the shell task report in check mode?",
        "command and shell cannot predict their effect, so check mode skips them, and diff has nothing to show. Modules that manage the file can.",
        "Replace the shell task with `ansible.builtin.lineinfile:` using `path`, `regexp: '^max_connections'` and `line: max_connections = 500` (`edit db.yml`), then `ansible-playbook db.yml --check --diff`."
      ],
      lesson: "Check mode is only as good as the modules in the play. Describe state with modules and --check --diff becomes a real preview.",
      tries: ["ansible-playbook db.yml --check --diff", "ansible db -a 'grep max_connections /etc/postgresql/16/main/postgresql.conf'"],
      won: (sim) => { const r = last(sim); const t = r && r.tasks.find((x) => /max_connections/.test(x.title)); return !!t && r.check && r.diff && ["db-01", "db-02"].every((h) => t.results[h] === "changed") && /\+max_connections = 500/.test(r.output) && ["db-01", "db-02"].every((h) => /max_connections = 100/.test(file(sim, h, "/etc/postgresql/16/main/postgresql.conf"))); },
      check: (sim) => { const n = ["db-01", "db-02"].filter((h) => /max_connections = 100/.test(file(sim, h, "/etc/postgresql/16/main/postgresql.conf"))).length; return fleetCheck("databases unchanged", n === 2, n === 2 ? "max_connections = 100 (good: preview first)" : "changed before approval: reset to try again"); }
    },

    // Secrets
    {
      id: "vault", title: "No vault secrets found", level: "10",
      story: "The database password moved into an encrypted file, group_vars/all/vault.yml. Since then the deploy fails immediately.",
      goal: "Deploy the app's environment file with the password. The vault password file is ~/.vault_pass.txt.",
      error: "ERROR! Attempting to decrypt but no vault secrets found",
      hosts: WEB.slice(0, 2).map((h) => app(h)),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all/main.yml": USER, "~/.vault_pass.txt": "practice-vault-pass\n",
        "inventory/group_vars/all/vault.yml": () => L.vaultEncrypt("---\nvault_db_password: practice-db-pass\n", "practice-vault-pass") + "\n",
        "site.yml": "---\n- name: Orders app\n  hosts: web\n  become: true\n  tasks:\n    - name: Write the environment file\n      ansible.builtin.copy:\n        content: \"DB_PASSWORD={{ vault_db_password }}\\n\"\n        dest: /etc/app/app.env\n        mode: \"0600\"\n        owner: app\n      no_log: true\n" },
      hints: [
        "`head -1 inventory/group_vars/all/vault.yml`. Ansible must decrypt it while loading the inventory, before any play.",
        "Ansible needs the vault password from somewhere: a prompt (-J), a file (--vault-password-file) or ansible.cfg. Decrypting the file in place would leave the password in plain text.",
        "`ansible-playbook site.yml --vault-password-file ~/.vault_pass.txt` (or add `vault_password_file = ~/.vault_pass.txt` to ansible.cfg)."
      ],
      lesson: "Vault files stay encrypted in the repository; the password reaches Ansible at run time from a prompt, a file outside the repository, or a script.",
      tries: ["ansible-playbook site.yml", "head -1 inventory/group_vars/all/vault.yml"],
      won: (sim) => okOn(last(sim), ["web-01", "web-02"]) && ["web-01", "web-02"].every((h) => /DB_PASSWORD=practice-db-pass/.test(file(sim, h, "/etc/app/app.env") || "")) && L.isVaultText(sim.read("inventory/group_vars/all/vault.yml") || ""),
      check: (sim) => fleetCheck("vault.yml", L.isVaultText(sim.read("inventory/group_vars/all/vault.yml") || ""), L.isVaultText(sim.read("inventory/group_vars/all/vault.yml") || "") ? "encrypted" : "plain text in the repository")
    },
    {
      id: "nolog", title: "Secrets printed in the CI log", level: "10",
      story: "Security found the app's admin password in last week's CI logs. CI runs every playbook with -v.",
      goal: "Run `ansible-playbook site.yml -v` so the password is set but appears nowhere in the output.",
      error: "changed: [web-01] => {\"changed\": true, \"cmd\": [\"/opt/app/bin/app-admin\", \"set-password\", \"practice-admin-pass\"], ...}",
      hosts: WEB.slice(0, 2).map((h) => app(h)),
      programs: { "app-admin": { run: (sim, h, a) => { h.files["/opt/app/admin.set"] = { content: a[1] || "", mode: "0600", owner: "app" }; return { rc: 0, out: "admin password updated\n", err: "" }; } } },
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all/main.yml": USER, "~/.vault_pass.txt": "practice-vault-pass\n",
        "inventory/group_vars/all/vault.yml": () => L.vaultEncrypt("---\nvault_admin_password: practice-admin-pass\n", "practice-vault-pass") + "\n",
        "ansible.cfg": "[defaults]\ninventory = inventory/hosts.ini\nhost_key_checking = True\ninterpreter_python = auto_silent\nvault_password_file = ~/.vault_pass.txt\n",
        "site.yml": "---\n- name: Orders app\n  hosts: web\n  become: true\n  tasks:\n    - name: Set the admin password\n      ansible.builtin.command:\n        argv:\n          - /opt/app/bin/app-admin\n          - set-password\n          - \"{{ vault_admin_password }}\"\n      changed_when: false\n" },
      hints: [
        "`ansible-playbook site.yml -v | grep practice`. Which part of the result shows the password?",
        "Vault protects the value at rest, not in task output. Removing -v only hides it until a failure prints the result.",
        "Add `no_log: true` to the task (`edit site.yml`), then `ansible-playbook site.yml -v`."
      ],
      lesson: "no_log: true censors a task's result in every output, including failures. Use it on any task that handles a secret.",
      tries: ["ansible-playbook site.yml -v", "cat site.yml"],
      won: (sim) => { const r = last(sim); return !!r && r.verbosity >= 1 && okOn(r, ["web-01", "web-02"]) && !/practice-admin-pass/.test(r.output) && ["web-01", "web-02"].every((h) => file(sim, h, "/opt/app/admin.set") === "practice-admin-pass"); },
      check: (sim) => { const leaked = sim.runs.some((r) => /practice-admin-pass/.test(r.output || "")); const r = last(sim); return fleetCheck("last log", !!r && !/practice-admin-pass/.test(r.output), !r ? "not run" : /practice-admin-pass/.test(r.output) ? "shows the password" : leaked ? "clean now (an earlier run leaked it: rotate it)" : "clean"); }
    },
    {
      id: "plaintext", title: "Password in plain text in Git", level: "10",
      story: "A code review flagged inventory/group_vars/all.yml: the database password is committed in plain text.",
      goal: "Keep the password only in Vault-encrypted form in the project, and deploy with it. Use ~/.vault_pass.txt as the vault password file.",
      error: "inventory/group_vars/all.yml:3: db_password: practice-db-pass",
      hosts: WEB.slice(0, 2).map((h) => app(h)),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "~/.vault_pass.txt": "practice-vault-pass\n",
        "inventory/group_vars/all.yml": "---\nansible_user: deploy\ndb_password: practice-db-pass\n",
        "site.yml": "---\n- name: Orders app\n  hosts: web\n  become: true\n  tasks:\n    - name: Write the environment file\n      ansible.builtin.copy:\n        content: \"DB_PASSWORD={{ db_password }}\\n\"\n        dest: /etc/app/app.env\n        mode: \"0600\"\n        owner: app\n      no_log: true\n" },
      hints: [
        "`grep -rn password inventory` finds it. Anything in the repository is readable by everyone who can clone it, forever.",
        "Either encrypt the whole file with `ansible-vault encrypt`, or encrypt just the value with `ansible-vault encrypt_string`. Then the playbook needs --vault-password-file.",
        "`ansible-vault encrypt_string --vault-password-file ~/.vault_pass.txt 'practice-db-pass' --name db_password >> inventory/group_vars/all.yml`, `sed -i '/db_password: practice-db-pass/d' inventory/group_vars/all.yml`, then `ansible-playbook site.yml --vault-password-file ~/.vault_pass.txt`."
      ],
      lesson: "Secrets go into Git only encrypted. A password that was ever committed in plain text must also be rotated: Git history keeps it.",
      tries: ["grep -rn password inventory", "cat site.yml"],
      won: (sim) => !sim.projectFiles().some((f) => (sim.read(f) || "").includes("practice-db-pass")) && okOn(last(sim), ["web-01", "web-02"]) && ["web-01", "web-02"].every((h) => /DB_PASSWORD=practice-db-pass/.test(file(sim, h, "/etc/app/app.env") || "")),
      check: (sim) => { const bad = sim.projectFiles().filter((f) => (sim.read(f) || "").includes("practice-db-pass")); return fleetCheck("plain-text secrets", !bad.length, bad.length ? `in ${bad.join(", ")}` : "none in the project"); }
    },
    {
      id: "sudoers", title: "A sudoers typo locks everyone out", level: "10",
      story: "The monitoring user needs to read service status with sudo. If a broken file lands in /etc/sudoers.d, sudo stops working for everyone, Ansible included, and only console access can repair it.",
      goal: "Deploy the monitoring rule to both web servers with sudo still working afterwards.",
      error: "fatal: [web-01]: FAILED! => {\"changed\": false, \"module_stderr\": \">>> /etc/sudoers.d/monitoring: syntax error near line 1 <<<\\nsudo: parse error in /etc/sudoers.d/monitoring near line 1\\nsudo: no valid sudoers sources found, quitting\\n...\", \"msg\": \"MODULE FAILURE\\nSee stdout/stderr for the exact error\", \"rc\": 1}",
      hosts: WEB.slice(0, 2),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Monitoring access\n  hosts: web\n  become: true\n  tasks:\n    - name: Allow monitoring to read service status\n      ansible.builtin.template:\n        src: monitoring.sudoers.j2\n        dest: /etc/sudoers.d/monitoring\n        mode: \"0440\"\n",
        "templates/monitoring.sudoers.j2": "monitoring ALL=(root) NOPASSWD /usr/bin/systemctl status *\n" },
      hints: [
        "Do not run it yet. `cat templates/monitoring.sudoers.j2`: is that valid sudoers syntax? sudo would refuse every file with an error, including its own config.",
        "The template module can test a file before installing it: `validate: visudo -cf %s`. A bad file is then rejected and never lands.",
        "Add `validate: visudo -cf %s` to the task, fix the rule to `NOPASSWD: /usr/bin/systemctl status *` (`edit site.yml`, `edit templates/monitoring.sudoers.j2`), then `ansible-playbook site.yml`. If you ran it already, `reset`."
      ],
      lesson: "validate runs a checker on the new file before it replaces the old one. For sudoers, sshd_config and similar files, it is the difference between an error and a lockout.",
      tries: ["cat templates/monitoring.sudoers.j2", "ansible-doc ansible.builtin.template"],
      won: (sim) => { const t = tasksIn(parse(sim, "site.yml")).find((x) => L.isDict(x["ansible.builtin.template"] || x.template)); const m = t && (t["ansible.builtin.template"] || t.template); return !!m && /visudo -c/.test(String(m.validate || "")) && ["web-01", "web-02"].every((h) => /NOPASSWD: \/usr\/bin\/systemctl status/.test(file(sim, h, "/etc/sudoers.d/monitoring") || "")) && okOn(last(sim), ["web-01", "web-02"]); },
      check: (sim) => { const broken = ["web-01", "web-02"].filter((h) => { const c = file(sim, h, "/etc/sudoers.d/monitoring"); return c !== null && !/NOPASSWD: /.test(c); }); return fleetCheck("sudo on the web servers", !broken.length, broken.length ? `broken on ${broken.join(", ")}: reset to try again` : "working"); }
    },
    {
      id: "becomeuser", title: "Becoming an unprivileged user fails", level: "02",
      story: "A new task creates the orders database as the postgres user. It fails on db-01 with a message about temporary files and permissions.",
      goal: "Create the orders database as postgres, without making Ansible's temporary files world-readable.",
      error: "fatal: [db-01]: FAILED! => {\"msg\": \"Failed to set permissions on the temporary files Ansible needs to create when becoming an unprivileged user (rc: 1, err: chmod: invalid mode: 'A+user:postgres:rx:allow'...\"}",
      hosts: [{ ...DB, accounts: { postgres: { shell: "/bin/bash", groups: [] } }, packages: { "postgresql-16": "16.4-0ubuntu0.24.04.2" }, services: { postgresql: {} } }],
      programs: { psql: { run: (sim, h, a, ctx) => {
        if (ctx.asUser !== "postgres") return { rc: 2, out: "", err: `psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "${ctx.asUser}" does not exist\n` };
        if (sim.db.created) return { rc: 1, out: "", err: "ERROR:  database \"orders\" already exists\n" };
        sim.db.created = true;
        return { rc: 0, out: "CREATE DATABASE\n", err: "" };
      } } },
      files: { "inventory/hosts.ini": "[db]\ndb-01 ansible_host=10.0.2.11\n", "inventory/group_vars/all.yml": USER,
        "db.yml": "---\n- name: Databases\n  hosts: db\n  become: true\n  tasks:\n    - name: Create the orders database\n      ansible.builtin.command: psql -c \"CREATE DATABASE orders\"\n      become_user: postgres\n" },
      hints: [
        "Run `ansible-playbook db.yml`. Ansible copies the module to a temporary file as deploy, then must let postgres read it.",
        "Without become_user the command runs as root, which has no database role. allow_world_readable_tmpfiles works but lets any local user read the module and its arguments.",
        "Give the host ACL support: `ansible db -m apt -a name=acl -b`, then `ansible-playbook db.yml`. Enabling `pipelining = True` under [ssh_connection] in ansible.cfg also avoids the temporary files."
      ],
      lesson: "Becoming an unprivileged user needs setfacl (the acl package) or pipelining, so the temporary module file can be shared safely.",
      tries: ["ansible-playbook db.yml", "ansible db -a 'which setfacl'"],
      won: (sim) => !!sim.db.created && !sim.cfgBool("allow_world_readable_tmpfiles", false) && okOn(last(sim), ["db-01"]),
      check: (sim) => fleetCheck("orders database", !!sim.db.created, sim.db.created ? (sim.cfgBool("allow_world_readable_tmpfiles", false) ? "created, with world-readable temp files" : "created") : "missing")
    },
    {
      id: "filemode", title: "mode: 600 is not 0600", level: "10",
      story: "The app's environment file holds its database password. After a cleanup that removed some quotes, the app refuses to start.",
      goal: "Run the app on both hosts with /etc/app/app.env readable by its owner only (0600).",
      error: "fatal: [web-01]: FAILED! => {\"changed\": false, \"msg\": \"Unable to restart service app: Job for app.service failed because the control process exited with error code.\\n...\"}",
      hosts: WEB.slice(0, 2).map((h) => app(h, "2.4", 8080, { files: { "/etc/app/app.env": { content: "DB_PASSWORD=practice-db-pass\n", mode: "01130", owner: "app" } }, services: { app: { running: false } } })),
      // The app runs as its own user: it must be able to read the file.
      startFails: (sim, h, unit) => unit === "app" && !!h.files["/etc/app/app.env"] && !(Number(h.files["/etc/app/app.env"].mode.slice(-3)[0]) & 4),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER + "db_password: practice-db-pass\n",
        "site.yml": "---\n- name: Orders app\n  hosts: web\n  become: true\n  tasks:\n    - name: Write the environment file\n      ansible.builtin.copy:\n        content: \"DB_PASSWORD={{ db_password }}\\n\"\n        dest: /etc/app/app.env\n        owner: app\n        mode: 600\n      no_log: true\n      notify: Restart app\n  handlers:\n    - name: Restart app\n      ansible.builtin.service:\n        name: app\n        state: restarted\n" },
      hints: [
        "Run `ansible-playbook site.yml`, then `ansible web -m stat -a path=/etc/app/app.env`. What mode did the file get?",
        "YAML reads 600 as the decimal number 600, which is 01130 in octal: the owner cannot read it. 0644 would start the app but let every user read the password.",
        "Quote it: `sed -i 's/mode: 600/mode: \"0600\"/' site.yml`, then run the play."
      ],
      lesson: "Always quote file modes. Unquoted, 0600 happens to work (YAML octal) but 600 is decimal and gives nonsense permissions.",
      tries: ["ansible-playbook site.yml", "ansible web -m stat -a path=/etc/app/app.env"],
      won: (sim) => ["web-01", "web-02"].every((h) => healthy(sim, h) && ["0600", "0400"].includes((sim.hosts[h].files["/etc/app/app.env"] || {}).mode)),
      check: (sim) => { const m = (sim.hosts["web-01"].files["/etc/app/app.env"] || {}).mode; return fleetCheck("app.env mode on web-01", ["0600", "0400"].includes(m), m || "missing"); }
    },

    // Scale and CI
    {
      id: "serial", title: "A rolling update takes every host down", level: "12",
      story: "Release 2.1 has a bug nobody has found yet. Last time a bad release went out, it hit all four web servers at once and the site went down until the rollback.",
      goal: "Deploy 2.1 so that a bad release can only ever take one server out: the deploy must stop with three servers still healthy.",
      error: "fatal: [web-01]: FAILED! => {... \"msg\": \"Status code was 503 and not [200]: HTTP Error 503: Service Unavailable\" ...}\nfatal: [web-02]: FAILED! ...\nfatal: [web-03]: FAILED! ...\nfatal: [web-04]: FAILED! ...\n\nNO MORE HOSTS LEFT",
      hosts: [...WEB.map((h) => app(h, "2.0")), { ...LB }],
      healthy: (sim, h) => String(h.files["/opt/app/VERSION"].content).trim() !== "2.1",
      files: { "inventory/hosts.ini": ini({ web: WEB, lb: [LB] }), "inventory/group_vars/all.yml": USER + "app_version: \"2.1\"\n",
        "deploy.yml": "---\n- name: Deploy the orders app\n  hosts: web\n  become: true\n  tasks:\n    - name: Install the release\n      ansible.builtin.copy:\n        content: \"{{ app_version }}\\n\"\n        dest: /opt/app/VERSION\n        mode: \"0644\"\n\n    - name: Restart the app\n      ansible.builtin.service:\n        name: app\n        state: restarted\n\n    - name: Check health\n      ansible.builtin.uri:\n        url: http://localhost:8080/healthz\n" },
      hints: [
        "Without serial, every task runs on all hosts before the next task starts, so a release that fails its health check fails everywhere at once.",
        "serial sets how many hosts go through the whole play at a time. When every host in a batch fails, Ansible stops before the next batch. serial: 2 would still take half the site down.",
        "Add `serial: 1` to the play (`edit deploy.yml`), then `ansible-playbook deploy.yml`. If you already broke all four, roll back first: `ansible-playbook deploy.yml -e app_version=2.0`."
      ],
      lesson: "serial turns a deploy into a rolling update: one batch at a time, and a failed batch stops the rest. Add max_fail_percentage to stop earlier in large fleets.",
      tries: ["cat deploy.yml", "ansible web -a 'cat /opt/app/VERSION'"],
      won: (sim) => { const r = last(sim); return !!r && (r.extra.app_version || "2.1") === "2.1" && !r.ok && names(WEB).filter((h) => healthy(sim, h)).length >= 3; },
      check: (sim) => { const n = names(WEB).filter((h) => healthy(sim, h)).length; return fleetCheck("healthy web servers", n >= 3, count(n, 4, "")); }
    },
    {
      id: "facts", title: "Fact gathering is slow on 500 hosts", level: "13",
      story: "The nightly baseline run over 500 edge nodes takes most of an hour, and the maintenance window is five minutes.",
      goal: "Get the baseline run under five minutes, as the timer callback reports.",
      error: "Playbook run took 0 days, 0 hours, 30 minutes, 0 seconds",
      hosts: Array.from({ length: 500 }, (x, i) => ({ name: `edge-${String(i + 1).padStart(3, "0")}`, ip: `10.8.${Math.floor((i + 1) / 250)}.${(i + 1) % 250 + 1}` })),
      files: { "inventory/hosts.ini": "[edge]\n" + Array.from({ length: 500 }, (x, i) => `edge-${String(i + 1).padStart(3, "0")} ansible_host=10.8.${Math.floor((i + 1) / 250)}.${(i + 1) % 250 + 1}`).join("\n") + "\n", "inventory/group_vars/all.yml": USER,
        "ansible.cfg": "[defaults]\ninventory = inventory/hosts.ini\nhost_key_checking = True\ninterpreter_python = auto_silent\ncallbacks_enabled = ansible.posix.timer\n",
        "baseline.yml": "---\n- name: Edge baseline\n  hosts: edge\n  become: true\n  tasks:\n    - name: Install chrony\n      ansible.builtin.apt:\n        name: chrony\n        state: present\n      when: ansible_facts['os_family'] == 'Debian'\n\n    - name: Message of the day\n      ansible.builtin.copy:\n        content: \"Edge node, managed by Ansible\\n\"\n        dest: /etc/motd\n        mode: \"0644\"\n" },
      hints: [
        "Run `ansible-playbook baseline.yml` and read the last line. Ansible works on forks hosts at a time; the default is 5, so 500 hosts take 100 rounds of every task.",
        "Full fact gathering is the slowest task. The play needs only os_family, which the minimal subset has. Turning facts off breaks the when. Hundreds of forks exhaust the control node.",
        "`echo 'forks = 50' >> ansible.cfg` alone gets close but not under five minutes; also add `gather_subset: [min]` to the play (`edit baseline.yml`), then run it."
      ],
      lesson: "Run time is roughly hosts / forks x per-task time. More forks (within the control node's memory) and gathering only the facts you use are the biggest wins.",
      tries: ["ansible-playbook baseline.yml", "ansible-config dump --only-changed"],
      won: (sim) => { const r = last(sim); return !!r && r.ok && r.time < 300 && Object.keys(r.stats).length === 500; },
      check: (sim) => { const r = last(sim); return fleetCheck("last run time", !!r && r.time < 300, r ? `${Math.floor(r.time / 60)}m ${r.time % 60}s` : "not run"); }
    },
    {
      id: "runonce", title: "Migrations run on every host", level: "12",
      story: "The deploy runs database migrations from each web server. Three of the four fail every release with a lock error, and someone has to rerun it.",
      goal: "Deploy release 2.5 with the migration run exactly once and every host succeeding.",
      error: "fatal: [web-02]: FAILED! => {\"changed\": true, \"cmd\": [\"/opt/app/bin/migrate\"], ... \"msg\": \"non-zero return code\", \"rc\": 1, \"stderr\": \"migration lock held by web-01; another migration is running\"}",
      hosts: WEB.map((h) => app(h, "2.4")), db: { schema: 41 },
      healthy: (sim, h) => !(String(h.files["/opt/app/VERSION"].content).trim() === "2.5" && sim.db.schema < 42),
      programs: { migrate: { run: (sim, h, a, ctx) => {
        const key = ctx.R ? ctx.R.record.tasks.length + ":" + sim.runs.length : null;
        if (key && sim.db.lock && sim.db.lock.key === key && sim.db.lock.host !== h.name) return { rc: 1, out: "", err: `migration lock held by ${sim.db.lock.host}; another migration is running\n` };
        sim.db.lock = { key, host: h.name };
        sim.db.migrations = (sim.db.migrations || 0) + 1;
        if (sim.db.schema >= 42) return { rc: 0, out: "No migrations to apply.\n", err: "" };
        sim.db.schema = 42;
        return { rc: 0, out: "Applying 0042_add_order_notes... OK\n", err: "" };
      } } },
      files: { "inventory/hosts.ini": ini({ web: WEB }), "inventory/group_vars/all.yml": USER + "app_version: \"2.5\"\n",
        "deploy.yml": "---\n- name: Deploy the orders app\n  hosts: web\n  become: true\n  tasks:\n    - name: Install the release\n      ansible.builtin.copy:\n        content: \"{{ app_version }}\\n\"\n        dest: /opt/app/VERSION\n        mode: \"0644\"\n\n    - name: Run database migrations\n      ansible.builtin.command: /opt/app/bin/migrate\n\n    - name: Restart the app\n      ansible.builtin.service:\n        name: app\n        state: restarted\n" },
      hints: [
        "Run `ansible-playbook deploy.yml`. Ansible runs a task on all hosts in parallel, so four migrations race for one lock.",
        "serial: 1 makes them wait for each other, but still runs the migration four times. The migration belongs to the database, not to each web server.",
        "Add `run_once: true` to the migration task (`edit deploy.yml`), then `ansible-playbook deploy.yml`."
      ],
      lesson: "run_once runs a task on one host of the batch and shares the result with the others: right for migrations, cache flushes and API calls.",
      tries: ["ansible-playbook deploy.yml", "cat deploy.yml"],
      won: (sim) => { const t = tasksIn(parse(sim, "deploy.yml")).find((x) => /migration/i.test(String(x.name || ""))); return okOn(last(sim), names(WEB)) && sim.db.schema >= 42 && !!t && t.run_once === true && names(WEB).every((h) => version(sim, h) === "2.5"); },
      check: (sim) => fleetCheck("database schema", sim.db.schema >= 42, `version ${sim.db.schema}`)
    },
    {
      id: "delegate", title: "Load balancer step runs on the wrong host", level: "12",
      story: "Deploys should take each web server out of the load balancer, update it, and put it back. The first task fails on every web server.",
      goal: "Deploy 2.5 to all four web servers with every one of them back in the load balancer pool.",
      error: "fatal: [web-01]: FAILED! => {\"changed\": false, \"cmd\": \"/usr/local/bin/lb-ctl disable web-01\", \"msg\": \"[Errno 2] No such file or directory: b'/usr/local/bin/lb-ctl'\", \"rc\": 2, ...}",
      hosts: [...WEB.map((h) => app(h, "2.4")), { ...LB, lb: names(WEB) }],
      programs: { "lb-ctl": { hosts: ["lb-01"], run: (sim, h, a) => {
        const [verb, name] = a;
        if (!name) return { rc: 2, out: "", err: "usage: lb-ctl disable|enable <server>\n" };
        h.lb.pool = verb === "disable" ? h.lb.pool.filter((x) => x !== name) : [...new Set([...h.lb.pool, name])];
        return { rc: 0, out: `${name} ${verb}d in backend web\n`, err: "" };
      } } },
      files: { "inventory/hosts.ini": ini({ web: WEB, lb: [LB] }), "inventory/group_vars/all.yml": USER + "app_version: \"2.5\"\n",
        "deploy.yml": "---\n- name: Deploy the orders app\n  hosts: web\n  become: true\n  serial: 1\n  tasks:\n    - name: Take the server out of the load balancer\n      ansible.builtin.command: /usr/local/bin/lb-ctl disable {{ inventory_hostname }}\n\n    - name: Install the release\n      ansible.builtin.copy:\n        content: \"{{ app_version }}\\n\"\n        dest: /opt/app/VERSION\n        mode: \"0644\"\n\n    - name: Restart the app\n      ansible.builtin.service:\n        name: app\n        state: restarted\n\n    - name: Put the server back\n      ansible.builtin.command: /usr/local/bin/lb-ctl enable {{ inventory_hostname }}\n" },
      hints: [
        "Run `ansible-playbook deploy.yml`. Where does lb-ctl exist? `ansible lb -a 'which lb-ctl'` and `ansible web -a 'which lb-ctl'`.",
        "The task should run on lb-01 while still talking about the web server being deployed. That is what delegate_to does; inventory_hostname stays the web server.",
        "Add `delegate_to: lb-01` to both lb-ctl tasks (`edit deploy.yml`), then `ansible-playbook deploy.yml`."
      ],
      lesson: "delegate_to runs one task on another host (a load balancer, a monitoring server) in the context of the host being deployed.",
      tries: ["ansible-playbook deploy.yml", "ansible lb -a 'cat /etc/hostname'"],
      won: (sim) => okOn(last(sim), names(WEB)) && names(WEB).every((h) => version(sim, h) === "2.5") && names(WEB).every((h) => sim.hosts["lb-01"].lb.pool.includes(h)),
      check: (sim) => fleetCheck("load balancer pool", sim.hosts["lb-01"].lb.pool.length === 4, `${sim.hosts["lb-01"].lb.pool.length} of 4 servers`)
    },
    {
      id: "upgrade", title: "include removed after an upgrade", level: "13",
      story: "The CI image moved from ansible-core 2.14 to 2.18. The same playbooks that passed yesterday now stop before the first play.",
      goal: "Get site.yml running on ansible-core 2.18.",
      error: "ERROR! [DEPRECATED]: ansible.builtin.include has been removed. Use include_tasks or import_tasks instead. This feature was removed from ansible-core in a release after 2023-05-16. Please update your playbooks.",
      hosts: WEB.slice(0, 2),
      files: { "inventory/hosts.ini": ini({ web: WEB.slice(0, 2) }), "inventory/group_vars/all.yml": USER,
        "site.yml": "---\n- name: Web servers\n  hosts: web\n  become: true\n  tasks:\n    - include: tasks/packages.yml\n",
        "tasks/packages.yml": "---\n- name: Install base packages\n  ansible.builtin.apt:\n    name: [curl, jq]\n    state: present\n" },
      hints: [
        "`ansible --version` shows the core version. The error names what was removed and what replaces it.",
        "`ansible.builtin.include` is the same removed action under its full name. import_tasks is static (read when the playbook loads); include_tasks is dynamic (read when reached).",
        "`sed -i 's/- include: /- ansible.builtin.import_tasks: /' site.yml`, then `ansible-playbook site.yml`."
      ],
      lesson: "Read the porting guide before upgrading ansible-core, and pin the version in CI so upgrades happen on purpose.",
      tries: ["ansible-playbook site.yml", "ansible --version"],
      won: (sim) => okOn(last(sim), ["web-01", "web-02"]) && ["web-01", "web-02"].every((h) => sim.hosts[h].packages.jq),
      check: (sim) => fleetCheck("site.yml", okOn(last(sim), ["web-01", "web-02"]), last(sim) ? (last(sim).error ? "stops before the first play" : okOn(last(sim), ["web-01", "web-02"]) ? "runs" : "fails") : "not run")
    },
    {
      id: "async", title: "Long task killed by a dropped connection", level: "13",
      story: "The monthly search reindex on db-01 takes about 40 minutes. The firewall drops SSH sessions that stay quiet for 15 minutes, and the task dies halfway every month.",
      goal: "Complete the reindex on db-01 from Ansible.",
      error: "fatal: [db-01]: UNREACHABLE! => {\"changed\": false, \"msg\": \"Failed to connect to the host via ssh: client_loop: send disconnect: Broken pipe\", \"unreachable\": true}",
      hosts: [DB],
      programs: { reindex: { run: (sim, h, a, ctx) => {
        if (!ctx.async) return { rc: 255, out: "", err: "", drop: "client_loop: send disconnect: Broken pipe" };
        h.files["/var/lib/app/reindex.done"] = { content: "ok\n", mode: "0644", owner: "root" };
        return { rc: 0, out: "Reindexed 48201113 rows in 41m12s\n", err: "" };
      } } },
      files: { "inventory/hosts.ini": "[db]\ndb-01 ansible_host=10.0.2.11\n", "inventory/group_vars/all.yml": USER,
        "reindex.yml": "---\n- name: Monthly reindex\n  hosts: db\n  become: true\n  tasks:\n    - name: Rebuild the search index\n      ansible.builtin.command: /opt/app/bin/reindex --all\n" },
      hints: [
        "Run `ansible-playbook reindex.yml`. The task holds one SSH session open, silent, for the whole run.",
        "A longer connection timeout (-T) applies only while connecting. async starts the job on the host and returns; poll checks back on it with short connections.",
        "Add `async: 3600` and `poll: 30` to the task (`edit reindex.yml`), then `ansible-playbook reindex.yml`."
      ],
      lesson: "async with poll runs long jobs in the background on the host, so no SSH session has to survive the whole job.",
      tries: ["ansible-playbook reindex.yml", "cat reindex.yml"],
      won: (sim) => !!file(sim, "db-01", "/var/lib/app/reindex.done") && okOn(last(sim), ["db-01"]),
      check: (sim) => fleetCheck("reindex", !!file(sim, "db-01", "/var/lib/app/reindex.done"), file(sim, "db-01", "/var/lib/app/reindex.done") ? "done" : "not finished")
    }
  ];

  const GROUPS = [
    ["Inventory and connection", ["publickey", "timeout", "hostkey", "sudopass", "nohosts", "limit", "python"]],
    ["Playbooks and modules", ["indent", "param", "aptlock", "registerloop", "copytemplate", "osfamily", "tagskip", "rescue"]],
    ["Variables and templates", ["undefined", "hostvars", "quotes", "stringfalse", "loopdict", "hostvarsfacts"]],
    ["Roles and collections", ["collection", "rolevars", "roledir", "rolemissing"]],
    ["Idempotency and handlers", ["shell", "changedwhen", "handlernever", "handlername", "flush", "checkmode"]],
    ["Secrets and access", ["vault", "nolog", "plaintext", "sudoers", "filemode", "becomeuser"]],
    ["Scale and CI", ["serial", "facts", "runonce", "delegate", "upgrade", "async"]]
  ];
  const ORDER = GROUPS.flatMap(([, ids]) => ids);
  SCENARIOS.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  for (const [group, ids] of GROUPS) for (const id of ids) SCENARIOS.find((x) => x.id === id).group = group;

  root.AQScenarios = { SCENARIOS, GROUPS };
})(typeof window !== "undefined" ? window : globalThis);
