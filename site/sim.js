// The Ansible playground's engine: a control node with a project directory,
// a modelled fleet of managed hosts, and the ansible, ansible-playbook,
// ansible-inventory, ansible-vault and ansible-galaxy commands working on them.
// Output and error messages follow ansible-core 2.18. Nothing here touches a
// real machine; there is no DOM access, so the tests drive it under Node.
"use strict";

(function (root) {
  const L = root.AQLang;
  const { isDict, toText, pyJson, pyRepr, Undef, TemplateError, YamlError, Vaulted, POS, TYPE } = L;

  const HOME = "/home/ops";
  const PROJECT = HOME + "/project";
  const CORE = "2.18.6";
  const START = Date.UTC(2026, 9, 30, 9, 12, 0);

  // --- the managed hosts ---------------------------------------------------------

  const OS = {
    ubuntu: { family: "Debian", distribution: "Ubuntu", version: "24.04", major: "24", pkg: "apt", python: "/usr/bin/python3", py: "3.12.3", label: "Ubuntu 24.04", kernel: "6.8.0-48-generic" },
    debian: { family: "Debian", distribution: "Debian", version: "12.7", major: "12", pkg: "apt", python: "/usr/bin/python3", py: "3.11.2", label: "Debian 12", kernel: "6.1.0-26-amd64" },
    rocky: { family: "RedHat", distribution: "Rocky", version: "9.4", major: "9", pkg: "dnf", python: "/usr/bin/python3", py: "3.9.18", label: "Rocky Linux 9", kernel: "5.14.0-427.13.1.el9_4.x86_64" }
  };
  // What each distribution's repositories offer, and the unit a package installs.
  const REPO = {
    Debian: {
      nginx: "1.24.0-2ubuntu7.1", apache2: "2.4.58-1ubuntu8.4", git: "1:2.43.0-1ubuntu7.1", curl: "8.5.0-2ubuntu10.4", haproxy: "2.8.5-1ubuntu3.1",
      "postgresql-16": "16.4-0ubuntu0.24.04.2", "redis-server": "5:7.0.15-1build2", chrony: "4.5-1ubuntu4.1", ufw: "0.36.2-6", htop: "3.3.0-4build1",
      tcpdump: "4.99.4-3ubuntu4", strace: "6.8-0ubuntu2", python3: "3.12.3-0ubuntu2", "python3-minimal": "3.12.3-0ubuntu2", jq: "1.7.1-3build1", acl: "2.3.2-1build1", openssl: "3.0.13-0ubuntu3.4", unzip: "6.0-28ubuntu4.1"
    },
    RedHat: {
      nginx: "1:1.20.1-20.el9.0.1", httpd: "2.4.62-1.el9", git: "2.43.5-1.el9_4", curl: "7.76.1-29.el9_4.1", haproxy: "2.4.22-3.el9_3", "postgresql-server": "13.16-1.el9_4",
      redis: "6.2.7-1.el9", chrony: "4.5-1.el9", htop: "3.3.0-1.el9", tcpdump: "4.99.0-9.el9", strace: "5.18-2.el9", python3: "3.9.18-3.el9_4.5", jq: "1.6-16.el9", openssl: "3.0.7-27.el9", firewalld: "1.3.4-1.el9", unzip: "6.0-56.el9"
    }
  };
  const UNITS = { nginx: "nginx", apache2: "apache2", httpd: "httpd", haproxy: "haproxy", "postgresql-16": "postgresql", "postgresql-server": "postgresql", "redis-server": "redis-server", redis: "redis", chrony: "chrony", ufw: "ufw", firewalld: "firewalld" };
  const DEFAULT_CONF = {
    nginx: { "/etc/nginx/nginx.conf": "user www-data;\nworker_processes auto;\nevents { worker_connections 768; }\nhttp { include /etc/nginx/conf.d/*.conf; }\n", "/etc/nginx/conf.d/": null },
    apache2: { "/etc/apache2/apache2.conf": "ServerRoot \"/etc/apache2\"\nListen 80\n" },
    httpd: { "/etc/httpd/conf/httpd.conf": "ServerRoot \"/etc/httpd\"\nListen 80\n" },
    haproxy: { "/etc/haproxy/haproxy.cfg": "global\n    daemon\ndefaults\n    mode http\n" }
  };
  // Directories that exist on every host; a path ending in / in DEFAULT_CONF is a directory a package creates.
  const BASE_DIRS = ["/etc", "/home", "/opt", "/tmp", "/var", "/srv", "/usr", "/root", "/var/www", "/usr/local", "/usr/local/bin", "/etc/systemd/system", "/var/log", "/etc/ssh", "/etc/ssh/sshd_config.d", "/etc/sudoers.d", "/var/lib"];
  function addDefaults(h, pkg) {
    for (const [p, c] of Object.entries(DEFAULT_CONF[pkg] || {})) {
      if (p.endsWith("/")) h.dirs.add(p.slice(0, -1));
      else if (!h.files[p]) h.files[p] = { content: c, mode: "0644", owner: "root" };
    }
  }
  const dirExists = (h, d) => !d || h.dirs.has(d) || Object.keys(h.files).some((p) => p.startsWith(d + "/")) || /^\/home\/[^/]+$/.test(d);
  // Where each service reads its configuration, to tell a running service's
  // loaded configuration from the files on disk.
  const CONF_DIR = { nginx: "/etc/nginx/", apache2: "/etc/apache2/", httpd: "/etc/httpd/", haproxy: "/etc/haproxy/", app: "/etc/app/", postgresql: "/etc/postgresql/" };

  function makeHost(def) {
    const os = OS[def.os || "ubuntu"];
    const h = {
      name: def.name, ip: def.ip, os, up: def.up !== false, python: def.python === undefined ? os.python : def.python,
      hostKey: def.hostKey || "key-" + def.name,
      logins: { deploy: { keys: ["id_ed25519"], sudo: "nopasswd" }, ...(def.logins || {}) },
      accounts: { root: { shell: "/bin/bash", groups: [] }, deploy: { shell: "/bin/bash", groups: ["sudo"] }, ...(def.accounts || {}) },
      packages: { ...(def.packages || {}) },
      files: {},
      services: {},
      dirs: new Set([...BASE_DIRS, ...(def.dirs || [])]),
      sudoPassword: def.sudoPassword || null,
      lb: def.lb ? { pool: [...def.lb] } : null
    };
    for (const [p, content] of Object.entries(def.files || {})) h.files[p] = typeof content === "string" ? { content, mode: "0644", owner: "root" } : content;
    for (const pkg of Object.keys(h.packages)) addDefaults(h, pkg);
    for (const [unit, st] of Object.entries(def.services || {})) {
      h.services[unit] = { running: st.running !== false, enabled: st.enabled !== false, restarts: 0, loaded: null };
      h.services[unit].loaded = st.stale ? "(an older configuration)" : st.running === false ? null : snapshot(h, unit);
    }
    return h;
  }
  function snapshot(h, unit) {
    const dir = CONF_DIR[unit];
    if (!dir) return "";
    return Object.keys(h.files).filter((p) => p.startsWith(dir)).sort().map((p) => p + "\n" + h.files[p].content).join("\n");
  }
  const confLine = (text, key) => { const m = new RegExp("^\\s*" + key + "\\s*[=:]?\\s*(\\S+?);?\\s*$", "m").exec(text || ""); return m ? m[1] : null; };

  // --- small helpers -----------------------------------------------------------------

  class AnsibleError extends Error {}
  class Out {
    constructor() { this.lines = []; this.status = 0; }
    say(text, cls = "") { for (const l of String(text).split("\n")) this.lines.push([l, cls]); }
  }
  function banner(o, text, cls = "banner") {
    o.say("");
    o.say(text + " " + "*".repeat(Math.max(3, 79 - text.length)), cls);
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const hex = (s, n) => L.hashHex(s).slice(0, n);
  const keyText = (k) => "AAAAC3NzaC1lZDI1NTE5AAAAI" + L.b64(hex(k, 24)).replace(/=+$/, "");
  const stamp = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "").replace(/\.(\d{3})$/, ".$1123");
  const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const boolish = (v) => (typeof v === "boolean" ? v : /^(yes|true|on|1)$/i.test(String(v)));

  // A shell-like split: quotes, and the operators && || ; | > >>.
  function shellSplit(line) {
    const toks = [];
    let cur = null;
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === q) q = null;
        else if (c === "\\" && q === '"' && /["\\$`]/.test(line[i + 1] || "")) cur += line[++i];
        else cur += c;
        continue;
      }
      if (c === "'" || c === '"') { q = c; cur = cur === null ? "" : cur; continue; }
      if (c === "\\" && i + 1 < line.length) { cur = (cur === null ? "" : cur) + line[++i]; continue; }
      if (/\s/.test(c)) { if (cur !== null) { toks.push(cur); cur = null; } continue; }
      const op = /^(&&|\|\||>>|[|;>])/.exec(line.slice(i));
      if (op) {
        if (cur !== null) { toks.push(cur); cur = null; }
        toks.push({ op: op[1] });
        i += op[1].length - 1;
        continue;
      }
      cur = (cur === null ? "" : cur) + c;
    }
    if (q) return null;
    if (cur !== null) toks.push(cur);
    return toks;
  }
  // [{ pipe: [argv, argv], redirect: {op, file}, then: "&&" | "||" | ";" }]
  function chains(toks) {
    const out = [];
    let cur = { pipe: [[]], redirect: null };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (typeof t === "string") { cur.pipe[cur.pipe.length - 1].push(t); continue; }
      if (t.op === "|") cur.pipe.push([]);
      else if (t.op === ">" || t.op === ">>") { cur.redirect = { op: t.op, file: typeof toks[i + 1] === "string" ? toks[++i] : null }; }
      else { cur.then = t.op; out.push(cur); cur = { pipe: [[]], redirect: null }; }
    }
    out.push(cur);
    return out.filter((c) => c.pipe[0].length);
  }

  // Flags: name -> [canonical, takesValue]. Booleans may be combined (-bK).
  function parseArgs(argv, spec) {
    const opts = { _: [], e: [], v: 0, unknown: [] };
    for (let i = 0; i < argv.length; i++) {
      let a = argv[i];
      if (/^-v+$/.test(a)) { opts.v += a.length - 1; continue; }
      if (a === "--verbose") { opts.v++; continue; }
      let val = null;
      if (a.startsWith("--") && a.includes("=")) { val = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
      const s = spec[a];
      if (s) {
        if (s[1]) {
          const v = val !== null ? val : argv[++i];
          if (v === undefined) { opts.missing = a; continue; }
          if (s[0] === "e") opts.e.push(v); else opts[s[0]] = v;
        } else opts[s[0]] = true;
        continue;
      }
      if (/^-[a-zA-Z]{2,}$/.test(a) && [...a.slice(1)].every((c) => spec["-" + c] && !spec["-" + c][1])) { for (const c of a.slice(1)) opts[spec["-" + c][0]] = true; continue; }
      if (/^-[a-zA-Z]/.test(a) && spec[a.slice(0, 2)] && spec[a.slice(0, 2)][1]) {
        const s2 = spec[a.slice(0, 2)];
        if (s2[0] === "e") opts.e.push(a.slice(2)); else opts[s2[0]] = a.slice(2);
        continue;
      }
      if (a.startsWith("-") && a !== "-") { opts.unknown.push(a); continue; }
      opts._.push(a);
    }
    return opts;
  }
  const COMMON = {
    "-i": ["inventory", 1], "--inventory": ["inventory", 1], "--inventory-file": ["inventory", 1], "-l": ["limit", 1], "--limit": ["limit", 1],
    "-e": ["e", 1], "--extra-vars": ["e", 1], "-u": ["user", 1], "--user": ["user", 1], "--private-key": ["key", 1], "--key-file": ["key", 1],
    "-b": ["become", 0], "--become": ["become", 0], "-K": ["askBecome", 0], "--ask-become-pass": ["askBecome", 0], "--become-user": ["becomeUser", 1],
    "-k": ["askPass", 0], "--ask-pass": ["askPass", 0], "-f": ["forks", 1], "--forks": ["forks", 1], "-C": ["check", 0], "--check": ["check", 0],
    "-D": ["diff", 0], "--diff": ["diff", 0], "--vault-password-file": ["vaultFile", 1], "--vault-pass-file": ["vaultFile", 1], "--vault-id": ["vaultId", 1],
    "-J": ["askVault", 0], "--ask-vault-pass": ["askVault", 0], "--ask-vault-password": ["askVault", 0], "-T": ["timeout", 1], "--timeout": ["timeout", 1],
    "-c": ["connection", 1], "--connection": ["connection", 1], "--list-hosts": ["listHosts", 0], "--version": ["version", 0], "-h": ["help", 0], "--help": ["help", 0]
  };
  const PLAYBOOK_FLAGS = {
    ...COMMON, "-t": ["tags", 1], "--tags": ["tags", 1], "--skip-tags": ["skipTags", 1], "--syntax-check": ["syntax", 0], "--list-tasks": ["listTasks", 0],
    "--list-tags": ["listTags", 0], "--start-at-task": ["startAt", 1], "--force-handlers": ["forceHandlers", 0], "--flush-cache": ["flushCache", 0], "--step": ["step", 0]
  };
  const ADHOC_FLAGS = { ...COMMON, "-m": ["module", 1], "--module-name": ["module", 1], "-a": ["args", 1], "--args": ["args", 1], "-o": ["oneLine", 0], "--one-line": ["oneLine", 0], "--playbook-dir": ["pbdir", 1] };

  // --- modules -----------------------------------------------------------------------

  // Supported parameters (and aliases) as each module documents them.
  const P = (s) => s.split(" ");
  const SPECS = {
    ping: { params: P("data") },
    setup: { params: P("fact_path filter gather_subset gather_timeout") },
    command: { params: P("_raw_params argv chdir cmd creates executable expand_argument_vars removes stdin stdin_add_newline strip_empty_ends"), free: true },
    shell: { params: P("_raw_params chdir cmd creates executable removes stdin stdin_add_newline strip_empty_ends"), free: true },
    raw: { params: P("_raw_params executable"), free: true, noPython: true },
    apt: { params: P("allow_change_held_packages allow_downgrade allow_unauthenticated autoclean autoremove cache_valid_time clean deb default_release dpkg_options fail_on_autoremove force force_apt_get install_recommends lock_timeout name only_upgrade policy_rc_d purge state update_cache update_cache_retries update_cache_retry_max_delay upgrade"),
      aliases: { "default-release": "default_release", "install-recommends": "install_recommends", package: "name", pkg: "name", "update-cache": "update_cache" }, states: P("absent build-dep fixed latest present") },
    dnf: { params: P("allow_downgrade allowerasing autoremove bugfix cacheonly conf_file disable_excludes disable_gpg_check disable_plugin disablerepo download_dir download_only enable_plugin enablerepo exclude install_repoquery install_weak_deps installroot list lock_timeout name nobest releasever security skip_broken sslverify state update_cache update_only use_backend validate_certs"),
      aliases: { pkg: "name", expire_cache: "update_cache" }, states: P("absent present installed removed latest") },
    package: { params: P("name state use"), states: P("absent present latest installed removed") },
    service: { params: P("arguments enabled name pattern runlevel sleep state use"), aliases: { args: "arguments" }, states: P("reloaded restarted started stopped") },
    systemd: { params: P("daemon_reexec daemon_reload enabled force masked name no_block scope state"), aliases: { "daemon-reexec": "daemon_reexec", "daemon-reload": "daemon_reload", service: "name", unit: "name" }, states: P("reloaded restarted started stopped") },
    copy: { params: P("attributes backup checksum content decrypt dest directory_mode follow force group local_follow mode owner remote_src selevel serole setype seuser src unsafe_writes validate") },
    template: { params: P("attributes backup block_end_string block_start_string comment_end_string comment_start_string dest follow force group lstrip_blocks mode newline_sequence output_encoding owner selevel serole setype seuser src trim_blocks unsafe_writes validate variable_end_string variable_start_string") },
    file: { params: P("access_time access_time_format attributes follow force group mode modification_time modification_time_format owner path recurse selevel serole setype seuser src state unsafe_writes"), aliases: { dest: "path", name: "path" }, states: P("absent directory file hard link touch") },
    lineinfile: { params: P("attributes backrefs backup create firstmatch group insertafter insertbefore line mode owner path regexp search_string selevel serole setype seuser state unsafe_writes validate"), aliases: { dest: "path", destfile: "path", name: "path", regex: "regexp", value: "line" }, states: P("absent present") },
    user: { params: P("append authorization comment create_home expires force generate_ssh_key group groups hidden home local login_class move_home name non_unique password password_expire_max password_expire_min password_lock profile remove role seuser shell skeleton ssh_key_bits ssh_key_comment ssh_key_file ssh_key_passphrase ssh_key_type state system uid umask update_password"), aliases: { createhome: "create_home", user: "name" }, states: P("absent present") },
    group: { params: P("force gid local name non_unique state system"), states: P("absent present") },
    debug: { params: P("msg var verbosity"), local: true },
    set_fact: { params: [], local: true, any: true },
    assert: { params: P("fail_msg quiet success_msg that"), aliases: { msg: "fail_msg" }, local: true },
    fail: { params: P("msg"), local: true },
    include_vars: { params: P("_raw_params depth dir extensions file files_matching hash_behaviour ignore_files ignore_unknown_extensions name"), local: true, free: true },
    include_tasks: { params: P("_raw_params apply file"), local: true, free: true },
    import_tasks: { params: P("_raw_params file"), local: true, free: true },
    include_role: { params: P("allow_duplicates apply defaults_from handlers_from name public rolespec_validate tasks_from vars_from"), local: true },
    import_role: { params: P("allow_duplicates defaults_from handlers_from name rolespec_validate tasks_from vars_from"), local: true },
    meta: { params: P("_raw_params"), local: true, free: true },
    uri: { params: P("attributes body body_format ca_path ciphers client_cert client_key creates decompress dest follow_redirects force force_basic_auth group headers http_agent method mode owner remote_src removes return_content src status_code timeout unix_socket unredirected_headers unsafe_writes url url_password url_username use_gssapi use_netrc use_proxy validate_certs") },
    stat: { params: P("checksum_algorithm follow get_attributes get_checksum get_mime path"), aliases: { dest: "path", name: "path" } },
    wait_for: { params: P("active_connection_states connect_timeout delay exclude_hosts host msg path port search_regex sleep state timeout") },
    ufw: { params: P("comment default delete direction from_ip from_port insert insert_relative_to interface interface_in interface_out log logging name policy port proto route rule state to_ip to_port"), aliases: { dest: "to_ip", src: "from_ip" }, collection: "community.general" }
  };
  SPECS.systemd_service = SPECS.systemd;
  SPECS.yum = SPECS.dnf;
  // Short names that ansible-core routes to a collection.
  const ROUTED = { ufw: "community.general.ufw" };
  const COLLECTIONS = { "community.general": "10.7.4", "ansible.posix": "2.0.0", "community.postgresql": "3.14.0", "community.mysql": "3.13.0", "community.docker": "4.6.1", "amazon.aws": "9.5.0", "kubernetes.core": "5.3.0" };

  // Turn what a task names into the module that runs, or null.
  function resolveModule(sim, name) {
    if (typeof name !== "string") return null;
    const m = /^(?:ansible\.(?:builtin|legacy)\.)?([a-z_]+)$/.exec(name);
    if (m && SPECS[m[1]] && !SPECS[m[1]].collection) return { short: m[1], fq: "ansible.builtin." + m[1] };
    const fq = ROUTED[name] || name;
    const c = /^([a-z_]+\.[a-z_]+)\.([a-z_]+)$/.exec(fq);
    if (c && sim.collections[c[1]] && SPECS[c[2]] && SPECS[c[2]].collection === c[1]) return { short: c[2], fq };
    return null;
  }

  const TASK_KEYS = new Set(P("name action args async become become_exe become_flags become_method become_user changed_when check_mode collections connection debugger delay delegate_facts delegate_to diff environment failed_when ignore_errors ignore_unreachable local_action loop loop_control module_defaults no_log notify poll port register remote_user retries run_once tags throttle timeout until vars when with_items with_dict with_list with_fileglob with_together with_sequence with_subelements with_nested with_indexed_items listen block rescue always any_errors_fatal"));
  const PLAY_KEYS = new Set(P("name hosts gather_facts gather_subset gather_timeout become become_user become_method vars vars_files vars_prompt roles tasks pre_tasks post_tasks handlers serial max_fail_percentage any_errors_fatal strategy tags remote_user connection environment force_handlers ignore_errors ignore_unreachable collections module_defaults order throttle run_once check_mode diff no_log port timeout debugger fact_path"));
  // What the user module prints instead of a password it was given.
  const MASKED = "NOT_LOGGING_PASSWORD";
  const ROOT_PATHS = /^\/(etc|usr|opt|var|srv|lib|bin|sbin|root|boot)\//;

  // --- the simulation ------------------------------------------------------------

  class Sim {
    constructor(scenario) {
      this.scenario = scenario;
      this.clock = START;
      this.files = {};
      this.dirs = new Set([HOME, PROJECT, HOME + "/.ssh"]);
      this.hosts = {};
      for (const d of scenario.hosts || []) this.hosts[d.name] = makeHost(d);
      this.network = {};
      for (const h of Object.values(this.hosts)) this.network[h.ip] = h.name;
      this.collections = { ...(scenario.collections || {}) };
      this.roleCache = {};
      this.runs = [];
      this.factCache = {};
      this.db = { schema: 0, lock: null, ...(scenario.db || {}) };
      const known = Object.values(this.hosts).filter((h) => !(scenario.unknownHosts || []).includes(h.name))
        .map((h) => `${h.ip} ssh-ed25519 ${keyText(scenario.oldKeys && scenario.oldKeys[h.name] ? scenario.oldKeys[h.name] : h.hostKey)}`);
      const base = {
        "~/.ssh/id_ed25519": "(practice key for the playground; not a real key)\n",
        "~/.ssh/id_ed25519.pub": "ssh-ed25519 " + keyText("ops") + " ops@control\n",
        "~/.ssh/known_hosts": known.join("\n") + "\n",
        "ansible.cfg": "[defaults]\ninventory = inventory/hosts.ini\nroles_path = ./roles\nhost_key_checking = True\ninterpreter_python = auto_silent\nretry_files_enabled = False\n"
      };
      for (const [p, c] of Object.entries({ ...base, ...(scenario.files || {}) })) if (c !== null) this.write(p, typeof c === "function" ? c(this) : c);
      if (scenario.setup) scenario.setup(this);
    }

    // Paths: ~ is the home directory, relative paths are inside the project.
    path(p) {
      p = String(p || "");
      if (p === "~") return HOME;
      if (p.startsWith("~/")) p = HOME + p.slice(1);
      else if (!p.startsWith("/")) p = PROJECT + "/" + p;
      const out = [];
      for (const part of p.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") out.pop(); else out.push(part);
      }
      return "/" + out.join("/");
    }
    read(p) { const f = this.files[this.path(p)]; return f === undefined ? null : f; }
    write(p, text) {
      const abs = this.path(p);
      this.files[abs] = String(text);
      for (let d = abs.slice(0, abs.lastIndexOf("/")); d.length > 1; d = d.slice(0, d.lastIndexOf("/"))) this.dirs.add(d);
    }
    isDir(p) { const abs = this.path(p); return this.dirs.has(abs) || Object.keys(this.files).some((f) => f.startsWith(abs + "/")); }
    list(p) {
      const abs = this.path(p);
      const names = new Set();
      for (const f of [...Object.keys(this.files), ...this.dirs]) if (f.startsWith(abs + "/")) names.add(f.slice(abs.length + 1).split("/")[0]);
      return [...names].sort();
    }
    rel(abs) { return abs.startsWith(PROJECT + "/") ? abs.slice(PROJECT.length + 1) : abs.startsWith(HOME + "/") ? "~" + abs.slice(HOME.length) : abs; }
    projectFiles() { return Object.keys(this.files).filter((f) => f.startsWith(PROJECT + "/")).map((f) => this.rel(f)).sort(); }
    // The editor saves through here.
    save(p, text) { this.write(p, text); }

    // ansible.cfg, read fresh each run as the real tools do.
    cfg(key, section = "defaults") {
      const text = this.read("ansible.cfg") || "";
      let sec = null;
      for (const raw of text.split("\n")) {
        const l = raw.replace(/^\s*[#;].*$/, "").trim();
        const s = /^\[(.+)\]$/.exec(l);
        if (s) { sec = s[1]; continue; }
        const m = /^([\w-]+)\s*[=:]\s*(.*)$/.exec(l);
        if (m && sec === section && m[1] === key) return m[2].trim();
      }
      return null;
    }
    cfgBool(key, dflt, section) { const v = this.cfg(key, section); return v === null ? dflt : boolish(v); }

    // The value a variable resolves to for a host with no extra vars, as the
    // project's files say: scenarios check fixes against this.
    resolve(host, name, playFile = "site.yml") {
      const R = this.context({}, new Out());
      try {
        R.inv = loadInventory(R, null);
        const plays = loadPlaybook(R, playFile);
        const play = plays.find((p) => matchHosts(R, p.ds.hosts, []).includes(host)) || plays[0];
        return realValue(lookupFor(R, host, { play, role: play && play.roles[0] })(name));
      } catch { return undefined; }
    }

    context(opts, o) {
      return { sim: this, o, opts, secrets: [], extra: {}, hs: {}, conn: {}, inv: null, check: !!opts.check, diff: !!opts.diff, verbosity: opts.v || 0, time: 0, printed: 0 };
    }

    exec(line) {
      const o = new Out();
      const toks = shellSplit(line);
      if (toks === null) { o.say("-bash: unexpected EOF while looking for matching quote", "bad"); return { out: o.lines }; }
      return this.runChains(chains(toks), o);
    }
    runChains(list, o) {
      let status = 0;
      for (let k = 0; k < list.length; k++) {
        const c = list[k];
        const res = this.runPipe(c, o);
        if (res && res.prompt) {
          const rest = list.slice(k + 1);
          const wrap = (p) => ({ ...p, answer: (s) => { const r = p.answer(s); return r.prompt ? { out: r.out, prompt: wrap(r.prompt) } : rest.length ? { out: r.out.concat(this.runChains(rest, new Out()).out) } : r; } });
          return { out: o.lines, prompt: wrap(res.prompt) };
        }
        if (res && res.edit) return { out: o.lines, edit: res.edit };
        status = o.status;
        if ((c.then === "&&" && status !== 0) || (c.then === "||" && status === 0)) break;
      }
      return { out: o.lines, status };
    }
    runPipe(c, o) {
      const sub = new Out();
      const res = command(this, c.pipe[0], sub, c.pipe.length > 1 ? c.pipe[1][0] : null);
      if (res && (res.prompt || res.edit)) { o.lines.push(...sub.lines); return res; }
      let lines = sub.lines;
      for (const argv of c.pipe.slice(1)) lines = filter(argv, lines, sub);
      o.status = sub.status;
      if (c.redirect) {
        if (!c.redirect.file) { o.say("-bash: syntax error near unexpected token `newline'", "bad"); o.status = 2; return null; }
        const target = this.path(c.redirect.file);
        if (!target.startsWith(HOME + "/")) { o.say(`-bash: ${c.redirect.file}: Permission denied`, "bad"); o.status = 1; return null; }
        const stderr = (cls) => cls === "bad" || cls === "warn" || cls === "stderr" || cls === "na";
        const text = lines.filter(([, cls]) => !stderr(cls)).map(([t]) => t).join("\n");
        const before = this.read(target);
        this.write(target, c.redirect.op === ">>" && before !== null ? before.replace(/\n?$/, "\n") + text + "\n" : text + "\n");
        o.lines.push(...lines.filter(([, cls]) => stderr(cls)));
        return null;
      }
      o.lines.push(...lines);
      return null;
    }
  }

  // grep, head, tail, wc -l and sort on another command's output.
  function filter(argv, lines, o) {
    const [cmd, ...args] = argv;
    const text = lines.map(([t]) => t);
    if (cmd === "grep") {
      const flags = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");
      const pat = args.find((a) => !/^-[a-zA-Z]+$/.test(a));
      if (pat === undefined) { o.status = 2; return [["Usage: grep [OPTION]... PATTERNS [FILE]...", "bad"]]; }
      let re;
      try { re = new RegExp(flags.includes("F") ? pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pat, flags.includes("i") ? "i" : ""); } catch { o.status = 2; return [["grep: Unmatched ( or \\(", "bad"]]; }
      const hit = lines.filter(([t]) => re.test(t) !== flags.includes("v"));
      o.status = hit.length ? 0 : 1;
      return flags.includes("c") ? [[String(hit.length), ""]] : hit;
    }
    if (cmd === "head" || cmd === "tail") {
      const n = Number((args.join(" ").match(/-n\s*(\d+)|-(\d+)/) || [])[1] || (args.join(" ").match(/-(\d+)/) || [])[1] || 10);
      return cmd === "head" ? lines.slice(0, n) : lines.slice(-n);
    }
    if (cmd === "wc") return [[String(text.filter((t, i) => i < text.length - 1 || t !== "").length), ""]];
    if (cmd === "sort") return [...lines].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (cmd === "less" || cmd === "more" || cmd === "cat") return lines;
    o.status = 127;
    return [[`-bash: ${cmd}: command not found`, "bad"]];
  }

  // --- the terminal ----------------------------------------------------------------

  function command(sim, argv, o, pipedInto) {
    const [cmd, ...args] = argv;
    const tools = {
      "ansible-playbook": () => ansiblePlaybook(sim, args, o),
      ansible: () => adhoc(sim, args, o),
      "ansible-inventory": () => ansibleInventory(sim, args, o),
      "ansible-vault": () => ansibleVault(sim, args, o),
      "ansible-galaxy": () => ansibleGalaxy(sim, args, o),
      "ansible-config": () => ansibleConfig(sim, args, o),
      "ansible-doc": () => ansibleDoc(sim, args, o, pipedInto),
      ssh: () => ssh(sim, args, o),
      "ssh-keygen": () => sshKeygen(sim, args, o),
      "ssh-keyscan": () => sshKeyscan(sim, args, o)
    };
    if (tools[cmd]) return tools[cmd]();
    return files(sim, cmd, args, o);
  }

  // Files on the control node: ls, cat, tree, edit, sed -i, mv, cp, rm, mkdir, echo.
  function files(sim, cmd, args, o) {
    const fail = (msg, code = 1) => { o.say(msg, "bad"); o.status = code; };
    const paths = args.filter((a) => !/^-/.test(a));
    if (cmd === "pwd") return o.say(PROJECT);
    if (cmd === "echo") return o.say(args.join(" "));
    if (cmd === "ls" || cmd === "tree") {
      const target = paths[0] || ".";
      if (sim.read(target) !== null) return o.say(target);
      if (!sim.isDir(target)) return fail(`${cmd}: cannot access '${target}': No such file or directory`, 2);
      if (cmd === "ls") return o.say(sim.list(target).filter((n) => args.includes("-a") || args.includes("-la") || !n.startsWith(".")).join("  "));
      const walk = (dir, pre) => sim.list(dir).filter((n) => !n.startsWith(".")).forEach((n, i, all) => {
        const last = i === all.length - 1;
        o.say(pre + (last ? "└── " : "├── ") + n);
        if (sim.isDir(dir + "/" + n)) walk(dir + "/" + n, pre + (last ? "    " : "│   "));
      });
      o.say(target);
      return walk(target, "");
    }
    if (cmd === "cat") {
      if (!paths.length) return fail("cat: missing file operand");
      for (const p of paths) {
        const t = sim.read(p);
        if (t === null) { fail(sim.isDir(p) ? `cat: ${p}: Is a directory` : `cat: ${p}: No such file or directory`); continue; }
        const rows = t.replace(/\n$/, "").split("\n");
        rows.forEach((r, i) => o.say(args.includes("-n") ? String(i + 1).padStart(6) + "\t" + r : r));
      }
      return null;
    }
    if (cmd === "edit" || cmd === "nano" || cmd === "vi" || cmd === "vim") {
      if (!paths[0]) return fail("Give the file to edit, for example: edit site.yml");
      const abs = sim.path(paths[0]);
      if (sim.isDir(abs)) return fail(`edit: ${paths[0]} is a directory`);
      if (!abs.startsWith(HOME + "/")) return fail(`edit: ${paths[0]}: files outside your home directory are on the managed hosts; change them with Ansible`);
      return { edit: { path: sim.rel(abs), text: sim.read(abs) || "" } };
    }
    if (cmd === "sed") {
      const i = args.indexOf("-i");
      const expr = args.find((a, k) => k !== i && !/^-/.test(a));
      const file = args.filter((a) => !/^-/.test(a) && a !== expr).pop();
      if (i < 0 || !expr || !file) return fail("sed: this playground runs sed -i 'EXPR' FILE, for example: sed -i 's/old/new/' site.yml");
      const text = sim.read(file);
      if (text === null) return fail(`sed: can't read ${file}: No such file or directory`, 2);
      const out = sedApply(text, expr);
      if (out === null) return fail(`sed: -e expression #1, char ${expr.length}: unknown command: \`${expr[0]}'`);
      sim.write(file, out);
      return null;
    }
    if (cmd === "mv" || cmd === "cp") {
      if (paths.length !== 2) return fail(`${cmd}: missing destination file operand after '${paths[0] || ""}'`);
      const [a, b] = paths.map((p) => sim.path(p));
      const moved = Object.keys(sim.files).filter((f) => f === a || f.startsWith(a + "/"));
      if (!moved.length && !sim.dirs.has(a)) return fail(`${cmd}: cannot stat '${paths[0]}': No such file or directory`);
      const dest = sim.isDir(b) ? b + "/" + a.split("/").pop() : b;
      for (const f of moved) {
        const text = sim.files[f];
        if (cmd === "mv") delete sim.files[f];
        sim.write(dest + f.slice(a.length), text);
      }
      if (cmd === "mv") for (const d of [...sim.dirs]) if (d === a || d.startsWith(a + "/")) sim.dirs.delete(d);
      if (!moved.length) sim.dirs.add(dest);
      return null;
    }
    if (cmd === "rm") {
      for (const p of paths) {
        const abs = sim.path(p);
        const hit = Object.keys(sim.files).filter((f) => f === abs || (args.some((a) => /r/.test(a)) && f.startsWith(abs + "/")));
        if (!hit.length) { if (!args.includes("-f")) fail(sim.isDir(abs) ? `rm: cannot remove '${p}': Is a directory` : `rm: cannot remove '${p}': No such file or directory`); continue; }
        for (const f of hit) delete sim.files[f];
      }
      return null;
    }
    if (cmd === "mkdir") { for (const p of paths) sim.dirs.add(sim.path(p)); return null; }
    if (cmd === "touch") { for (const p of paths) if (sim.read(p) === null) sim.write(p, ""); return null; }
    if (cmd === "cd") return o.say("This playground stays in ~/project. Use paths instead, for example: cat roles/nginx/tasks/main.yml", "na");
    if (cmd === "export") return o.say("This playground has no environment variables; pass options on the command line, for example --vault-password-file ~/.vault_pass.txt", "na");
    if (/^(ansible-lint|molecule|ansible-navigator|ansible-pull|ansible-console|ansible-test|ansible-builder|ansible-runner|pip|pip3|python|python3|vagrant|terraform|kubectl|docker|sudo|apt|apt-get|dnf|yum|systemctl|git)$/.test(cmd)) {
      o.status = 127;
      return o.say(`${cmd} needs a real machine; this playground simulates ansible, ansible-playbook, ansible-inventory, ansible-vault, ansible-galaxy, ansible-doc, ansible-config and ssh. Try it in the course lab.`, "na");
    }
    o.status = 127;
    return o.say(`-bash: ${cmd}: command not found`, "bad");
  }

  // sed's s/a/b/[g], /re/d and Ns/a/b/ on a file's text; null when the expression is not understood.
  function sedApply(text, expr) {
    const lines = text.split("\n");
    const m = /^(\d+|\/[^/]*\/)?([sd])(.*)$/s.exec(expr);
    if (!m) return null;
    const addr = m[1];
    const hit = (line, n) => !addr || (/^\d+$/.test(addr) ? Number(addr) === n + 1 : safeRe(addr.slice(1, -1)).test(line));
    if (m[2] === "d") return m[3] ? null : lines.filter((l, n) => !hit(l, n)).join("\n");
    const sep = m[3][0];
    if (!sep) return null;
    // Split on the separator, but not where it is escaped (s/a\/b/c/).
    const bits = [""];
    for (let i = 1; i < m[3].length; i++) {
      const ch = m[3][i];
      if (ch === "\\" && m[3][i + 1] === sep) { bits[bits.length - 1] += (sep === "/" ? "\\/" : sep); i++; } else if (ch === sep) bits.push(""); else bits[bits.length - 1] += ch;
    }
    if (bits.length < 3) return null;
    const re = safeRe(bits[0].replace(/\\\(/g, "(").replace(/\\\)/g, ")"), bits[2].includes("g") ? "g" : "");
    return lines.map((l, n) => (hit(l, n) ? l.replace(re, bits[1].replace(/\\(\d)/g, "$$$1").replace(/&/g, "$$&").replace(/\\n/g, "\n").replace(/\\(.)/g, "$1")) : l)).join("\n");
  }
  function safeRe(src, flags = "") { try { return new RegExp(src, flags); } catch { return /(?!)/; } }

  // --- ssh from the control node ------------------------------------------------------

  // Who and how Ansible (or ssh) connects: the first reason it cannot, or null.
  function sshProblem(sim, h, addr, user, key, opts = {}) {
    if (!h || !h.up) {
      if (!h && !/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return `ssh: Could not resolve hostname ${addr}: Name or service not known`;
      return `ssh: connect to host ${addr} port 22: Connection timed out`;
    }
    if (sim.cfgBool("host_key_checking", true) && !opts.noHostKey) {
      const known = (sim.read("~/.ssh/known_hosts") || "").split("\n").filter((l) => [addr, h.name, h.ip].includes(l.split(" ")[0]));
      if (!known.length) return "Host key verification failed.";
      if (!known.some((l) => l.split(" ")[2] === keyText(h.hostKey))) {
        return `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\nIT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\r\nSomeone could be eavesdropping on you right now (man-in-the-middle attack)!\r\nIt is also possible that a host key has just been changed.\r\nThe fingerprint for the ED25519 key sent by the remote host is\nSHA256:${L.b64(hex(h.hostKey, 32)).slice(0, 43)}.\r\nPlease contact your system administrator.\r\nAdd correct host key in ${HOME}/.ssh/known_hosts to get rid of this message.\r\nOffending ED25519 key in ${HOME}/.ssh/known_hosts:${(sim.read("~/.ssh/known_hosts") || "").split("\n").findIndex((l) => l.split(" ")[0] === addr) + 1}\r\nHost key for ${addr} has changed and you have requested strict checking.\r\nHost key verification failed.`;
      }
    }
    const login = h.logins[user];
    const keyName = key ? sim.path(key).split("/").pop() : null;
    const haveKey = keyName ? sim.read(key) !== null : true;
    if (!login || !haveKey || !login.keys.some((k) => (keyName ? k === keyName : ["id_ed25519", "id_rsa"].includes(k)))) return `${user}@${addr}: Permission denied (publickey).`;
    return null;
  }

  function ssh(sim, args, o) {
    const spec = { "-i": ["key", 1], "-p": ["port", 1], "-o": ["opt", 1], "-l": ["login", 1], "-v": ["verbose", 0], "-t": ["tty", 0], "-T": ["notty", 0] };
    // Options come before the destination; everything after it is the remote command.
    let at = 0;
    while (at < args.length && args[at].startsWith("-")) at += spec[args[at]] && spec[args[at]][1] ? 2 : 1;
    const a = parseArgs(args.slice(0, at + 1), spec);
    a._ = [args[at], ...args.slice(at + 1)].filter((x) => x !== undefined);
    const target = a._[0];
    if (!target) { o.status = 255; return o.say("usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-i identity_file] [-l login_name] [-p port] destination [command [argument ...]]", "bad"); }
    const [user, host] = target.includes("@") ? target.split("@") : [a.login || "ops", target];
    const h = sim.hosts[sim.network[host] || host];
    const problem = sshProblem(sim, h, host, user, a.key);
    if (problem) {
      o.status = 255;
      if (problem === "Host key verification failed." && h) {
        o.say(`The authenticity of host '${host} (${h.ip})' can't be established.\nED25519 key fingerprint is SHA256:${L.b64(hex(h.hostKey, 32)).slice(0, 43)}.\nThis key is not known by any other names.`);
        return { prompt: { text: "Are you sure you want to continue connecting (yes/no/[fingerprint])? ", answer: (s) => {
          const r = new Out();
          if (s.trim() !== "yes") { r.say("Host key verification failed.", "bad"); return { out: r.lines }; }
          sim.write("~/.ssh/known_hosts", (sim.read("~/.ssh/known_hosts") || "") + `${host} ssh-ed25519 ${keyText(h.hostKey)}\n`);
          r.say(`Warning: Permanently added '${host}' (ED25519) to the list of known hosts.`, "warn");
          const again = sshProblem(sim, h, host, user, a.key);
          if (again) r.say(again.replace(/\r/g, ""), "bad"); else r.say(`Welcome to ${h.os.label} (GNU/Linux ${h.os.kernel} x86_64)`);
          return { out: r.lines };
        } } };
      }
      return o.say(problem.replace(/\r/g, ""), "bad");
    }
    const rest = a._.slice(1).join(" ");
    if (!rest) return o.say(`Welcome to ${h.os.label} (GNU/Linux ${h.os.kernel} x86_64)\n${user}@${h.name}:~$ logout\nConnection to ${host} closed. (This playground runs one command per ssh: ssh ${target} 'command')`);
    const r = hostShell(sim, h, rest, { user, root: user === "root" });
    if (r.out) o.say(r.out.replace(/\n$/, ""));
    if (r.err) o.say(r.err.replace(/\n$/, ""), "bad");
    o.status = r.rc;
    return null;
  }

  function sshKeygen(sim, args, o) {
    const r = args.indexOf("-R");
    if (r < 0 || !args[r + 1]) return o.say("ssh-keygen: this playground supports ssh-keygen -R <host>, to forget a host's old key", "na");
    const host = args[r + 1];
    const text = sim.read("~/.ssh/known_hosts") || "";
    const rows = text.split("\n");
    const at = rows.findIndex((l) => l.split(" ")[0] === host);
    if (at < 0) { o.status = 1; return o.say(`Host ${host} not found in ${HOME}/.ssh/known_hosts`); }
    sim.write("~/.ssh/known_hosts.old", text);
    sim.write("~/.ssh/known_hosts", rows.filter((l) => l.split(" ")[0] !== host).join("\n"));
    o.say(`# Host ${host} found: line ${at + 1}\n${HOME}/.ssh/known_hosts updated.\nOriginal contents retained as ${HOME}/.ssh/known_hosts.old`);
    return null;
  }

  function sshKeyscan(sim, args, o) {
    const hosts = args.filter((x) => !x.startsWith("-") && !/^(ed25519|rsa|ecdsa)$/.test(x));
    if (!hosts.length) { o.status = 1; return o.say("usage: ssh-keyscan [-46cDHv] [-f file] [-p port] [-T timeout] [-t type] [host | addrlist namelist]", "bad"); }
    for (const host of hosts) {
      const h = sim.hosts[sim.network[host] || host];
      if (!h || !h.up) { o.say(`${host}: Connection timed out`, "warn"); continue; }
      o.say(`# ${host}:22 SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5`, "warn");
      o.say(`${host} ssh-ed25519 ${keyText(h.hostKey)}`);
    }
    return null;
  }

  // --- commands on a managed host -----------------------------------------------------

  // A small /bin/sh: enough for what tasks and ssh run. Returns {rc, out, err}.
  function hostShell(sim, h, line, ctx) {
    const toks = shellSplit(String(line));
    if (!toks) return { rc: 2, out: "", err: "/bin/sh: 1: Syntax error: Unterminated quoted string\n" };
    let res = { rc: 0, out: "", err: "" };
    let all = "";
    for (const c of chains(toks)) {
      let input = null;
      for (const argv of c.pipe) {
        res = program(sim, h, argv, ctx, input);
        input = res.out;
      }
      if (c.redirect && c.redirect.file) {
        const path = c.redirect.file;
        if (!ctx.root && ROOT_PATHS.test(path)) res = { rc: 2, out: "", err: `/bin/sh: 1: cannot create ${path}: Permission denied\n` };
        else {
          const before = h.files[path] ? h.files[path].content : "";
          h.files[path] = { content: c.redirect.op === ">>" ? before + res.out : res.out, mode: "0644", owner: ctx.root ? "root" : ctx.user };
          res = { ...res, out: "" };
        }
      }
      all += res.out;
      if ((c.then === "&&" && res.rc !== 0) || (c.then === "||" && res.rc === 0)) break;
    }
    return { ...res, out: all };
  }

  function program(sim, h, argv, ctx, input) {
    let [cmd, ...args] = argv;
    if (cmd === "sudo") {
      if (args[0] === "-n" && h.logins[ctx.user] && h.logins[ctx.user].sudo === "password") return { rc: 1, out: "", err: "sudo: a password is required\n" };
      if (h.logins[ctx.user] && h.logins[ctx.user].sudo === "none") return { rc: 1, out: "", err: `${ctx.user} is not in the sudoers file.\n` };
      if (h.logins[ctx.user] && h.logins[ctx.user].sudo === "password" && !ctx.root) return { rc: 1, out: "", err: "sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\nsudo: a password is required\n" };
      return program(sim, h, args.filter((a) => a !== "-n"), { ...ctx, root: true }, input);
    }
    const ok = (out = "") => ({ rc: 0, out, err: "" });
    const err = (rc, e) => ({ rc, out: "", err: e + "\n" });
    const scn = sim.scenario.programs && (sim.scenario.programs[cmd] || sim.scenario.programs[cmd.split("/").pop()]);
    if (scn && (!scn.hosts || scn.hosts.includes(h.name))) return scn.run(sim, h, args, ctx);
    const file = (p) => h.files[p];
    switch (cmd) {
      case "echo": return ok(args.filter((a) => a !== "-e" && a !== "-n").join(" ") + (args.includes("-n") ? "" : "\n"));
      case "true": return ok();
      case "false": return err(1, "").rc ? { rc: 1, out: "", err: "" } : ok();
      case "sleep": return ok();
      case "hostname": return ok(h.name + "\n");
      case "whoami": return ok((ctx.root ? "root" : ctx.user) + "\n");
      case "id": return ok(args.includes("-u") ? (ctx.root ? "0\n" : "1001\n") : ctx.root ? "uid=0(root) gid=0(root) groups=0(root)\n" : `uid=1001(${ctx.user}) gid=1001(${ctx.user}) groups=1001(${ctx.user}),27(sudo)\n`);
      case "uptime": return ok(" 09:12:44 up 41 days,  3:02,  1 user,  load average: 0.08, 0.05, 0.01\n");
      case "date": return ok(new Date(sim.clock).toUTCString() + "\n");
      case "cat": {
        if (!args.length) return ok(input || "");
        const f = file(args[0]);
        return f ? ok(f.content) : err(1, `cat: ${args[0]}: No such file or directory`);
      }
      case "grep": {
        const flags = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");
        const [pat, path] = args.filter((a) => !/^-[a-zA-Z]+$/.test(a));
        const text = path ? (file(path) ? file(path).content : null) : input || "";
        if (text === null) return err(2, `grep: ${path}: No such file or directory`);
        const hit = text.split("\n").filter((l) => l && safeRe(pat || "", flags.includes("i") ? "i" : "").test(l) !== flags.includes("v"));
        if (flags.includes("q")) return { rc: hit.length ? 0 : 1, out: "", err: "" };
        if (flags.includes("c")) return { rc: hit.length ? 0 : 1, out: hit.length + "\n", err: "" };
        return { rc: hit.length ? 0 : 1, out: hit.map((l) => l + "\n").join(""), err: "" };
      }
      case "wc": return ok(String((input || "").split("\n").filter(Boolean).length) + "\n");
      case "test": case "[": {
        const [flag, path] = args;
        const exists = flag === "-d" ? Object.keys(h.files).some((p) => p.startsWith(path + "/")) : !!file(path);
        return { rc: exists ? 0 : 1, out: "", err: "" };
      }
      case "ls": {
        const path = args.find((a) => !a.startsWith("-")) || "/home/" + ctx.user;
        const kids = Object.keys(h.files).filter((p) => p.startsWith(path.replace(/\/$/, "") + "/")).map((p) => p.slice(path.replace(/\/$/, "").length + 1).split("/")[0]);
        if (file(path)) return ok(path + "\n");
        return kids.length ? ok([...new Set(kids)].sort().join("  ") + "\n") : err(2, `ls: cannot access '${path}': No such file or directory`);
      }
      case "which": case "command": {
        const name = args.filter((a) => a !== "-v").pop();
        const found = { python3: h.python, python: null, nginx: h.packages.nginx && "/usr/sbin/nginx", git: h.packages.git && "/usr/bin/git", curl: (h.packages.curl || h.os.family) && "/usr/bin/curl", apt: h.os.pkg === "apt" && "/usr/bin/apt", dnf: h.os.pkg === "dnf" && "/usr/bin/dnf", sudo: "/usr/bin/sudo" }[name];
        return found ? ok(found + "\n") : { rc: 1, out: "", err: "" };
      }
      case "python3": case "python": case "/usr/bin/python3": case "/usr/bin/python":
        if (!h.python || (cmd.startsWith("/") && cmd !== h.python) || cmd === "python" || cmd === "/usr/bin/python") return err(127, `/bin/sh: 1: ${cmd}: not found`);
        return ok(args.includes("--version") || args.includes("-V") ? `Python ${h.os.py}\n` : "");
      case "touch": case "mkdir": case "rm": case "cp": case "chmod": case "chown": {
        const path = args.filter((a) => !a.startsWith("-")).pop();
        if (!ctx.root && path && ROOT_PATHS.test(path)) return err(1, `${cmd}: cannot ${cmd === "rm" ? "remove" : cmd === "mkdir" ? "create directory" : "touch"} '${path}': Permission denied`);
        if (cmd === "touch" && path && !file(path)) h.files[path] = { content: "", mode: "0644", owner: ctx.root ? "root" : ctx.user };
        if (cmd === "rm" && path) delete h.files[path];
        if (cmd === "rm" && /\/var\/lib\/(dpkg|apt\/lists)\/lock/.test(path || "") && h.aptLock) { h.dpkgBroken = true; h.aptLock = 0; }
        return ok();
      }
      case "useradd": case "adduser": {
        const name = args.filter((a) => !a.startsWith("-")).pop();
        if (!ctx.root) return err(1, `${cmd}: Permission denied.\n${cmd}: cannot lock /etc/passwd; try again later.`);
        if (h.accounts[name]) return err(9, `${cmd}: user '${name}' already exists`);
        h.accounts[name] = { shell: "/bin/sh", groups: [] };
        return ok();
      }
      case "sed": {
        const path = args[args.length - 1];
        const expr = args.find((a, i) => i < args.length - 1 && !a.startsWith("-"));
        if (!file(path)) return err(2, `sed: can't read ${path}: No such file or directory`);
        if (!ctx.root && ROOT_PATHS.test(path)) return err(4, `sed: couldn't open temporary file ${path.replace(/[^/]*$/, "")}sedAbC12x: Permission denied`);
        const out = sedApply(file(path).content, expr || "");
        if (out === null) return err(1, `sed: -e expression #1, char 1: unknown command`);
        if (args.includes("-i")) { file(path).content = out; return ok(); }
        return ok(out);
      }
      case "systemctl": case "service": {
        const [verb, unit] = cmd === "service" ? [args[1], args[0]] : [args[0], args[1]];
        const svc = unit && h.services[unit.replace(/\.service$/, "")];
        if (verb === "daemon-reload") return ctx.root ? ok() : err(1, "Failed to reload daemon: Access denied");
        if (verb === "is-active") return svc && svc.running ? ok("active\n") : { rc: 3, out: "inactive\n", err: "" };
        if (verb === "is-enabled") return svc && svc.enabled ? ok("enabled\n") : { rc: 1, out: "disabled\n", err: "" };
        if (!svc) return err(5, `Unit ${unit}.service not found.`);
        if (verb === "status") return { rc: svc.running ? 0 : 3, out: `● ${unit}.service\n     Active: ${svc.running ? "active (running)" : "inactive (dead)"}\n`, err: "" };
        if (!ctx.root) return err(1, `Failed to ${verb} ${unit}.service: Access denied\nSee system logs and 'systemctl status ${unit}.service' for details.`);
        const r = serviceAction(sim, h, unit.replace(/\.service$/, ""), verb === "restart" ? "restarted" : verb === "stop" ? "stopped" : verb === "reload" ? "reloaded" : "started");
        return r.error ? err(1, r.error.replace(/\n$/, "")) : ok();
      }
      case "visudo": {
        const path = args[args.length - 1];
        const f = file(path);
        if (!f) return err(1, `visudo: unable to open ${path}: No such file or directory`);
        return sudoersValid(f.content) ? ok(`${path}: parsed OK\n`) : { rc: 1, out: "", err: `${path}:1:${(f.content.split("\n").find((l) => l.trim() && !l.startsWith("#") && !sudoersValid(l)) || "").indexOf("NOPASSWD") + 9}: syntax error\n` };
      }
      case "nginx": {
        if (!h.packages.nginx) return err(127, "/bin/sh: 1: nginx: not found");
        const bad = Object.keys(h.files).find((p) => p.startsWith("/etc/nginx/") && /\{\{/.test(h.files[p].content));
        return bad ? err(1, `nginx: [emerg] unknown directive "{{" in ${bad}:1\nnginx: configuration file /etc/nginx/nginx.conf test failed`) : ok("nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n");
      }
      case "apt-get": case "apt": case "dnf": case "yum": {
        const names = args.filter((a) => !a.startsWith("-") && !/^(install|update|upgrade|remove)$/.test(a));
        if (!ctx.root) return err(100, cmd.startsWith("apt") ? "E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?" : "Error: This command has to be run with superuser privileges (under the root user on most systems).");
        if ((cmd.startsWith("apt") ? "apt" : "dnf") !== h.os.pkg) return err(127, `/bin/sh: 1: ${cmd}: not found`);
        if (!args.includes("install")) return ok("Reading package lists... Done\n");
        for (const n of names) {
          if (!REPO[h.os.family][n]) return err(100, `E: Unable to locate package ${n}`);
          installPackage(h, n);
        }
        return ok(`Reading package lists... Done\nSetting up ${names.join(", ")} ...\n`);
      }
      case "curl": case "wget": {
        const url = args.find((a) => /^https?:\/\//.test(a)) || "";
        const r = httpGet(sim, h, url);
        if (r.status < 0) return err(7, `curl: (7) Failed to connect to ${r.host} port ${r.port} after 0 ms: Couldn't connect to server`);
        if (r.status >= 400 && args.some((a) => /^-[a-zA-Z]*f/.test(a))) return err(22, `curl: (22) The requested URL returned error: ${r.status}`);
        return ok(r.body + "\n");
      }
      default:
        return err(127, `/bin/sh: 1: ${cmd}: not found`);
    }
  }

  // One user specification per line: who where=(as_whom) [NOPASSWD:] commands.
  function sudoersValid(text) {
    return String(text).split("\n").every((l) => !l.trim() || l.trim().startsWith("#") || /^(Defaults\b.*|%?[\w.-]+\s+[\w.,-]+\s*=\s*\([^)]*\)\s*(NOPASSWD:\s*)?(?!NOPASSWD)\S.*)$/.test(l.trim()));
  }

  function installPackage(h, name, version) {
    h.packages[name] = version || REPO[h.os.family][name];
    addDefaults(h, name);
    if (/^python3/.test(name)) h.python = "/usr/bin/python3";
    const unit = UNITS[name];
    // Debian starts and enables a service on install; Red Hat leaves it stopped.
    if (unit && !h.services[unit]) {
      const deb = h.os.family === "Debian";
      h.services[unit] = { running: deb, enabled: deb, restarts: 0, loaded: null };
      if (deb) h.services[unit].loaded = snapshot(h, unit);
    }
  }

  // Start, stop or restart a unit. A service whose configuration is broken
  // fails to start, as nginx -t or the app would.
  function serviceAction(sim, h, unit, state) {
    const svc = h.services[unit];
    const fails = () => {
      const bad = Object.keys(h.files).some((p) => CONF_DIR[unit] && p.startsWith(CONF_DIR[unit]) && /\{\{|\{%/.test(h.files[p].content));
      const custom = sim.scenario.startFails && sim.scenario.startFails(sim, h, unit);
      return bad || custom;
    };
    const verb = { started: "start", restarted: "restart", reloaded: "reload", stopped: "stop" }[state];
    if (state === "stopped") { const ch = svc.running; svc.running = false; svc.loaded = null; return { changed: ch }; }
    if (state === "started" && svc.running) return { changed: false };
    if (fails()) {
      svc.running = false;
      svc.loaded = null;
      return { error: `Job for ${unit}.service failed because the control process exited with error code.\nSee "systemctl status ${unit}.service" and "journalctl -xeu ${unit}.service" for details.\n`, verb };
    }
    svc.running = true;
    svc.loaded = snapshot(h, unit);
    svc.restarts++;
    svc.at = sim.clock++;
    return { changed: true };
  }

  // What an HTTP request from (or to) a host returns: the app answers on the
  // port its loaded configuration names.
  function httpGet(sim, from, url) {
    const m = /^https?:\/\/([^/:]+)(?::(\d+))?(\/[^\s]*)?$/.exec(url);
    if (!m) return { status: -1, host: url, port: 80, body: "" };
    const host = m[1] === "localhost" || m[1] === "127.0.0.1" ? from : sim.hosts[sim.network[m[1]] || m[1]];
    const port = Number(m[2] || 80);
    const res = host && sim.scenario.http ? sim.scenario.http(sim, host, port, m[3] || "/") : null;
    if (res) return { host: m[1], port, ...res };
    const app = host && host.services.app;
    if (app && app.running && Number(confLine(app.loaded, "port")) === port) {
      const healthy = !sim.scenario.healthy || sim.scenario.healthy(sim, host);
      return { host: m[1], port, status: healthy ? 200 : 503, body: healthy ? "ok" : "unhealthy" };
    }
    const web = host && ["nginx", "apache2", "httpd"].find((u) => host.services[u] && host.services[u].running);
    if (web && port === 80) return { host: m[1], port, status: 200, body: "<html>welcome</html>" };
    return { host: m[1], port, status: -1, body: "" };
  }

  // --- inventory and variables ---------------------------------------------------------

  function readVarsFile(R, abs) {
    let text = R.sim.files[abs];
    if (text === undefined) return null;
    if (L.isVaultText(text)) text = decryptOrThrow(R, text, abs);
    const data = parseFile(R, abs, text);
    return isDict(data) ? data : {};
  }
  function decryptOrThrow(R, text, abs) {
    if (!R.secrets.length) throw new AnsibleError("Attempting to decrypt but no vault secrets found");
    for (const s of R.secrets) { const p = L.vaultDecrypt(text, s); if (p !== null) return p; }
    throw new AnsibleError(`Decryption failed (no vault secrets were found that could decrypt) on ${abs}`);
  }
  function parseFile(R, abs, text) {
    const warnings = [];
    try {
      const data = L.parseYaml(text, warnings);
      for (const w of warnings) R.o.say(`[WARNING]: While constructing a mapping from ${abs}, line ${w.line}, column ${w.col}, found a duplicate dict key (${w.key}). Using last defined value only.`, "warn");
      return data;
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
      throw new AnsibleError(`We were unable to read either as JSON nor YAML, these are the errors we got from each:\nJSON: Expecting value: line 1 column 1 (char 0)\n\nSyntax Error while loading YAML.\n  ${e.message}\n\n${L.whereText(abs, text, e.line, e.col)}${e.quoteHint ? L.QUOTE_HINT : ""}`);
    }
  }
  // group_vars/web.yml, group_vars/web.yaml, group_vars/web or group_vars/web/*.yml
  function varsDir(R, dir, name) {
    const sim = R.sim;
    const base = dir + "/" + name;
    const out = {};
    for (const f of [base, base + ".yml", base + ".yaml", base + ".json"]) if (sim.files[f] !== undefined) Object.assign(out, readVarsFile(R, f));
    for (const f of Object.keys(sim.files).filter((x) => x.startsWith(base + "/")).sort()) Object.assign(out, readVarsFile(R, f));
    return out;
  }

  function loadInventory(R, sources) {
    const sim = R.sim;
    const inv = { hosts: {}, groups: { all: { hosts: [], children: [], vars: {} }, ungrouped: { hosts: [], children: [], vars: {} } }, dirs: [] };
    const list = sources ? sources : [sim.cfg("inventory") || "/etc/ansible/hosts"];
    let parsed = 0;
    for (const src of list.flatMap((s) => String(s).split(/,(?=.)/))) {
      if (String(src).endsWith(",") || (list.length === 1 && String(sources && sources[0]).includes(",") && sim.read(src) === null)) {
        for (const h of String(src).split(",").filter(Boolean)) { inv.hosts[h] = inv.hosts[h] || { vars: {} }; inv.groups.ungrouped.hosts.push(h); }
        parsed++;
        continue;
      }
      const abs = sim.path(src);
      const filesToRead = sim.isDir(abs) ? Object.keys(sim.files).filter((f) => f.startsWith(abs + "/") && !/\/(group_vars|host_vars)\//.test(f) && !f.slice(abs.length + 1).includes("/")) : sim.files[abs] !== undefined ? [abs] : [];
      if (!filesToRead.length) {
        R.o.say(`[WARNING]: Unable to parse ${abs} as an inventory source`, "warn");
        continue;
      }
      for (const f of filesToRead) {
        const text = sim.files[f];
        const one = /\.ya?ml$/.test(f) ? yamlInventory(R, f, text) : L.parseIni(text);
        for (const [h, x] of Object.entries(one.hosts)) inv.hosts[h] = { vars: { ...(inv.hosts[h] || { vars: {} }).vars, ...x.vars } };
        for (const [g, x] of Object.entries(one.groups)) {
          const t = inv.groups[g] || (inv.groups[g] = { hosts: [], children: [], vars: {} });
          for (const h of x.hosts) if (!t.hosts.includes(h)) t.hosts.push(h);
          for (const c of x.children) if (!t.children.includes(c)) t.children.push(c);
          Object.assign(t.vars, x.vars);
        }
      }
      inv.dirs.push(sim.isDir(abs) ? abs : abs.slice(0, abs.lastIndexOf("/")));
      parsed++;
    }
    if (!parsed) {
      R.o.say("[WARNING]: No inventory was parsed, only implicit localhost is available", "warn");
    }
    if (!Object.keys(inv.hosts).length) R.o.say("[WARNING]: provided hosts list is empty, only localhost is available. Note that the implicit localhost does not match 'all'", "warn");
    // Hosts in no group but all are "ungrouped".
    const grouped = new Set(Object.entries(inv.groups).filter(([g]) => g !== "all" && g !== "ungrouped").flatMap(([, x]) => x.hosts));
    inv.groups.ungrouped.hosts = Object.keys(inv.hosts).filter((h) => !grouped.has(h));
    inv.groups.all.children = Object.keys(inv.groups).filter((g) => g !== "all" && !Object.values(inv.groups).some((x) => x.children.includes(g)));
    return inv;
  }
  function yamlInventory(R, abs, text) {
    const data = parseFile(R, abs, text) || {};
    const inv = { hosts: {}, groups: {} };
    const walk = (name, node) => {
      const g = inv.groups[name] || (inv.groups[name] = { hosts: [], children: [], vars: {} });
      if (!isDict(node)) return;
      for (const [h, vars] of Object.entries(node.hosts || {})) {
        for (const hn of L.expandRange(h)) { inv.hosts[hn] = { vars: { ...(inv.hosts[hn] || { vars: {} }).vars, ...(isDict(vars) ? vars : {}) } }; g.hosts.push(hn); }
      }
      Object.assign(g.vars, isDict(node.vars) ? node.vars : {});
      for (const [c, child] of Object.entries(node.children || {})) { g.children.push(c); walk(c, child); }
    };
    for (const [g, node] of Object.entries(isDict(data) ? data : {})) walk(g, node);
    return inv;
  }

  // Every group a host is in, parents included, ordered as Ansible merges
  // them: shallowest first, then by name.
  function groupsOf(inv, host) {
    inv.cache = inv.cache || {};
    return inv.cache[host] || (inv.cache[host] = groupsOfUncached(inv, host));
  }
  function groupsOfUncached(inv, host) {
    const depth = {};
    const visit = (g, d) => {
      if (depth[g] !== undefined && depth[g] >= d) return;
      depth[g] = d;
      for (const c of (inv.groups[g] || { children: [] }).children) visit(c, d + 1);
    };
    visit("all", 0);
    const member = new Set(Object.entries(inv.groups).filter(([, x]) => x.hosts.includes(host)).map(([g]) => g));
    let grew = true;
    while (grew) {
      grew = false;
      for (const [g, x] of Object.entries(inv.groups)) if (!member.has(g) && x.children.some((c) => member.has(c))) { member.add(g); grew = true; }
    }
    member.add("all");
    return [...member].sort((a, b) => (depth[a] || 0) - (depth[b] || 0) || (a < b ? -1 : 1));
  }

  function matchHosts(R, pattern, warnings) {
    const inv = R.inv;
    const all = Object.keys(inv.hosts);
    const members = (g) => all.filter((h) => groupsOf(inv, h).includes(g));
    let out = null;
    const terms = String(pattern == null ? "" : pattern).split(/[,:](?![^[]*\])/).map((x) => x.trim()).filter(Boolean);
    for (const raw of terms) {
      const op = raw[0] === "!" || raw[0] === "&" ? raw[0] : "";
      const t = raw.slice(op.length);
      let hit;
      if (t === "all" || t === "*") hit = all;
      else if (inv.groups[t]) hit = members(t);
      else if (inv.hosts[t]) hit = [t];
      else if (t.startsWith("~")) hit = all.filter((h) => safeRe(t.slice(1)).test(h));
      else if (t.includes("*")) { const re = safeRe("^" + t.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"); hit = [...new Set([...all.filter((h) => re.test(h)), ...Object.keys(inv.groups).filter((g) => re.test(g)).flatMap(members)])]; }
      else { hit = []; if (warnings) warnings.push(t); }
      if (op === "!") out = (out || all).filter((h) => !hit.includes(h));
      else if (op === "&") out = (out || all).filter((h) => hit.includes(h));
      else out = [...new Set([...(out || []), ...hit])];
    }
    const set = new Set(out || []);
    return all.filter((h) => set.has(h));
  }

  // Inventory-level variables for a host, in Ansible's precedence order.
  function inventoryVars(R, host, pbdir) {
    const inv = R.inv;
    const key = host + "|" + pbdir;
    if (R.invCache && R.invCache[key]) return R.invCache[key];
    const groups = groupsOf(inv, host);
    const dirs = [...new Set(inv.dirs)];
    const pdirs = pbdir && !dirs.includes(pbdir) ? [pbdir] : [];
    const v = {};
    for (const g of groups) Object.assign(v, inv.groups[g].vars);
    for (const d of dirs) Object.assign(v, varsDir(R, d + "/group_vars", "all"));
    for (const d of pdirs) Object.assign(v, varsDir(R, d + "/group_vars", "all"));
    for (const g of groups.filter((x) => x !== "all")) { for (const d of dirs) Object.assign(v, varsDir(R, d + "/group_vars", g)); for (const d of pdirs) Object.assign(v, varsDir(R, d + "/group_vars", g)); }
    Object.assign(v, (inv.hosts[host] || { vars: {} }).vars);
    for (const d of dirs) Object.assign(v, varsDir(R, d + "/host_vars", host));
    for (const d of pdirs) Object.assign(v, varsDir(R, d + "/host_vars", host));
    (R.invCache || (R.invCache = {}))[key] = v;
    return v;
  }

  function factsOf(R, name, subset) {
    const h = R.sim.hosts[name];
    if (!h) return {};
    const f = {
      hostname: h.name, fqdn: h.name + ".internal", nodename: h.name, os_family: h.os.family, distribution: h.os.distribution, distribution_version: h.os.version,
      distribution_major_version: h.os.major, pkg_mgr: h.os.pkg, service_mgr: "systemd", system: "Linux", kernel: h.os.kernel, architecture: "x86_64",
      python_version: h.os.py, python: { executable: h.python, version: { major: 3, minor: Number(h.os.py.split(".")[1]), micro: Number(h.os.py.split(".")[2]) } },
      user_id: "deploy", user_dir: "/home/deploy", discovered_interpreter_python: h.python
    };
    if (subset !== "min") Object.assign(f, { default_ipv4: { address: h.ip, interface: "eth0", gateway: h.ip.replace(/\.\d+$/, ".1") }, all_ipv4_addresses: [h.ip], processor_vcpus: 2, memtotal_mb: 3911 });
    return f;
  }

  const realValue = (v) => (v instanceof Undef ? undefined : v);

  // The variable lookup for one host and task: every layer, lowest first.
  function lookupFor(R, host, scope = {}) {
    const sim = R.sim;
    const play = scope.play;
    const pbdir = play ? play.dir : PROJECT;
    const hs = R.hs[host] || {};
    const merged = {};
    const roles = play ? play.roles : [];
    const current = scope.role;
    for (const r of roles) if (r !== current) Object.assign(merged, r.defaults);
    if (current) Object.assign(merged, current.defaults);
    Object.assign(merged, inventoryVars(R, host, pbdir));
    const facts = hs.facts;
    if (facts) {
      merged.ansible_facts = facts;
      for (const [k, v] of Object.entries(facts)) merged["ansible_" + k] = v;
    }
    if (play) { Object.assign(merged, play.vars); for (const vf of play.varsFiles) Object.assign(merged, vf); }
    for (const r of roles) if (r !== current) Object.assign(merged, r.vars);
    if (current) Object.assign(merged, current.vars);
    for (const tv of scope.taskVars || []) Object.assign(merged, tv);
    Object.assign(merged, hs.setFacts || {});
    Object.assign(merged, R.extra);
    const groups = R.inv.groupMap || (R.inv.groupMap = Object.fromEntries(Object.keys(R.inv.groups).map((g) => [g, matchHosts(R, g)])));
    const magic = {
      inventory_hostname: host, inventory_hostname_short: host.split(".")[0], groups, group_names: groupsOf(R.inv, host).filter((g) => g !== "all" && g !== "ungrouped"),
      hostvars: hostvarsProxy(R, play), play_hosts: scope.playHosts || [], ansible_play_hosts: scope.playHosts || [], ansible_play_batch: scope.playHosts || [],
      ansible_check_mode: R.check, ansible_version: { full: CORE, major: 2, minor: 18, revision: 6, string: CORE }, playbook_dir: pbdir,
      role_path: current ? current.path : undefined, role_name: current ? current.name : undefined, omit: "__omit_place_holder__",
      lookup: (kind, ...a) => lookupPlugin(R, kind, a), query: (kind, ...a) => asList(lookupPlugin(R, kind, a)), q: (kind, ...a) => asList(lookupPlugin(R, kind, a)), range: (a, b, s = 1) => { const out = []; if (b === undefined) { b = a; a = 0; } for (let x = a; s > 0 ? x < b : x > b; x += s) out.push(x); return out; }
    };
    const depth = { n: 0 };
    const look = (n) => {
      if (scope.local && n in scope.local) return scope.local[n];
      let v = Object.prototype.hasOwnProperty.call(merged, n) ? merged[n] : magic[n];
      if (v === undefined) return new Undef(`'${n}' is undefined`);
      if (v instanceof Vaulted) v = decryptOrThrowTemplate(R, v);
      if (typeof v === "string" && /\{\{|\{%/.test(v)) {
        if (++depth.n > 40) throw new TemplateError(`recursive loop detected in template string: ${v}`);
        try { v = L.render(v, look); } finally { depth.n--; }
      } else if (v && typeof v === "object" && !v[TYPE]) v = deep(v);
      return v;
    };
    const deep = (v) => (Array.isArray(v) ? v.map(deep) : isDict(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x instanceof Vaulted ? decryptOrThrowTemplate(R, x) : typeof x === "string" && /\{\{/.test(x) ? L.render(x, look) : deep(x)])) : v);
    return look;
  }
  function decryptOrThrowTemplate(R, v) {
    try { return decryptOrThrow(R, v.cipher, "") .replace(/\n$/, ""); } catch (e) { throw new TemplateError(e.message.replace(/ on $/, "")); }
  }
  function hostvarsProxy(R, play) {
    return {
      [TYPE]: "ansible.vars.hostvars.HostVars object",
      get: (h) => {
        if (!R.inv.hosts[h]) return undefined;
        const look = lookupFor(R, h, { play: play && { ...play, roles: [] } });
        return { [TYPE]: "ansible.vars.hostvars.HostVarsVars object", get: (k) => { const v = look(k); return v instanceof Undef ? undefined : v; } };
      }
    };
  }
  function lookupPlugin(R, kind, a) {
    kind = String(kind).replace(/^ansible\.builtin\./, "");
    if (kind === "env") return a[0] === "HOME" ? HOME : a[0] === "USER" ? "ops" : "";
    if (kind === "file") { const t = R.sim.read(a[0]); if (t === null) throw new TemplateError(`The 'file' lookup had an issue accessing the file '${a[0]}'. file not found, use -vvvvv to see paths searched`); return t.replace(/\n$/, ""); }
    if (kind === "vars") return lookupFor(R, "localhost", {})(a[0]);
    throw new TemplateError(`lookup plugin (${kind}) not found`);
  }

  // --- playbooks, roles and tasks ----------------------------------------------------------

  function where(R, abs, node) {
    const pos = POS.get(node);
    return pos ? L.whereText(abs, R.sim.files[abs] || "", pos.line, pos.col) : "";
  }

  // The action a task runs, its arguments, and whether Ansible can find it.
  function actionOf(R, ds, abs) {
    if (!isDict(ds)) throw new AnsibleError(`A malformed block was encountered while loading tasks: ${pyRepr(ds)} should be a list or None but is <class '${typeof ds === "string" ? "ansible.parsing.yaml.objects.AnsibleUnicode" : "NoneType"}'>\n\n${where(R, abs, ds)}`);
    if (ds.block !== undefined) return { block: true };
    let keys = Object.keys(ds).filter((k) => !TASK_KEYS.has(k) && !/^with_/.test(k));
    if (ds.action !== undefined || ds.local_action !== undefined) {
      const v = ds.action ?? ds.local_action;
      const [mod, ...rest] = String(isDict(v) ? v.module : v).split(" ");
      keys = [mod];
      ds = { ...ds, [mod]: isDict(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "module")) : rest.join(" ") };
    }
    if (!keys.length) throw new AnsibleError(`no module/action detected in task.\n\n${where(R, abs, ds)}`);
    if (keys.length > 1) {
      const known = keys.filter((k) => resolveModule(R.sim, k));
      if (known.length > 1) throw new AnsibleError(`conflicting action statements: ${known.join(", ")}\n\n${where(R, abs, ds)}`);
      const unknown = keys.find((k) => !resolveModule(R.sim, k));
      throw new AnsibleError(`couldn't resolve module/action '${unknown}'. This often indicates a misspelling, missing collection, or incorrect module path.\n\n${where(R, abs, ds)}`);
    }
    const name = keys[0];
    if (/^(ansible\.builtin\.|ansible\.legacy\.)?include$/.test(name)) throw new AnsibleError(`[DEPRECATED]: ansible.builtin.include has been removed. Use include_tasks or import_tasks instead. This feature was removed from ansible-core in a release after 2023-05-16. Please update your playbooks.`);
    const mod = resolveModule(R.sim, name);
    if (!mod) throw new AnsibleError(`couldn't resolve module/action '${name}'. This often indicates a misspelling, missing collection, or incorrect module path.\n\n${where(R, abs, ds)}`);
    let raw = ds[name];
    const spec = SPECS[mod.short];
    let args;
    if (raw === null || raw === undefined) args = {};
    else if (isDict(raw)) args = { ...raw };
    else if (spec.free && !/^(include_vars)$/.test(mod.short)) args = mod.short === "command" || mod.short === "shell" || mod.short === "raw" || mod.short === "meta" ? (() => { const kv = L.parseKv(raw); const free = String(raw).replace(/\s+(creates|removes|chdir|executable)=\S+/g, ""); return { _raw_params: /^(creates|removes|chdir)=/.test(free) ? kv._raw_params : free, ...Object.fromEntries(Object.entries(kv).filter(([k]) => /^(creates|removes|chdir|executable)$/.test(k))) }; })() : { _raw_params: String(raw) };
    else if (mod.short === "include_vars") args = { _raw_params: String(raw) };
    else args = L.parseKv(raw);
    if (isDict(ds.args)) args = { ...ds.args, ...args };
    return { name, mod, args };
  }

  // Tasks from a list, flattened through import_tasks; include_tasks stays
  // dynamic. Each task carries what it inherits.
  function compileTasks(R, list, abs, inherit) {
    if (list === null || list === undefined) return [];
    if (!Array.isArray(list)) throw new AnsibleError(`A malformed block was encountered while loading tasks: ${pyRepr(list)} should be a list or None but is <class '${typeof list === "string" ? "ansible.parsing.yaml.objects.AnsibleUnicode" : "ansible.parsing.yaml.objects.AnsibleMapping"}'>\n\n${where(R, abs, list)}`);
    const out = [];
    for (const ds of list) {
      const act = actionOf(R, ds, abs);
      const own = {
        tags: [...inherit.tags, ...asList(ds.tags).map(String)], when: [...inherit.when, ...asList(ds.when)],
        become: ds.become !== undefined ? ds.become : inherit.become, vars: [...inherit.vars, ...(isDict(ds.vars) ? [ds.vars] : [])],
        no_log: ds.no_log !== undefined ? ds.no_log : inherit.no_log, delegate_to: ds.delegate_to !== undefined ? ds.delegate_to : inherit.delegate_to
      };
      if (act.block) {
        const sub = { ...inherit, ...own };
        out.push({ ds, abs, role: inherit.role, block: compileTasks(R, ds.block, abs, sub), rescue: compileTasks(R, ds.rescue, abs, sub), always: compileTasks(R, ds.always, abs, sub), ...own });
        continue;
      }
      const { mod, args, name } = act;
      if (mod.short === "import_tasks") {
        const file = resolveTaskFile(R, args.file || args._raw_params, abs, inherit.role);
        if (!file) throw new AnsibleError(`Could not find or access '${args.file || args._raw_params}'\n\n${where(R, abs, ds)}`);
        out.push(...compileTasks(R, parseFile(R, file, R.sim.files[file]), file, { ...inherit, ...own }));
        continue;
      }
      if (mod.short === "import_role") {
        const role = loadRole(R, args.name, abs, ds);
        out.push(...compileTasks(R, role.tasks, role.tasksFile, { ...inherit, ...own, role }));
        continue;
      }
      out.push({ ds, abs, name: ds.name, action: name, mod, args, role: inherit.role, ...own });
    }
    return out;
  }
  function resolveTaskFile(R, file, fromAbs, role) {
    const sim = R.sim;
    const cands = [];
    if (role) cands.push(role.path + "/tasks/" + file);
    cands.push(fromAbs.slice(0, fromAbs.lastIndexOf("/")) + "/" + file, sim.path(file));
    return cands.find((c) => sim.files[c] !== undefined) || null;
  }

  function rolePaths(R, pbdir) {
    const cfg = (R.sim.cfg("roles_path") || "~/.ansible/roles:/usr/share/ansible/roles:/etc/ansible/roles").split(":").map((p) => R.sim.path(p));
    return [pbdir + "/roles", ...cfg, pbdir];
  }
  function loadRole(R, name, abs, ds) {
    const sim = R.sim;
    const pbdir = R.pbdir;
    const dirs = rolePaths(R, pbdir);
    const dir = dirs.map((d) => d + "/" + name).find((d) => sim.isDir(d));
    if (!dir) throw new AnsibleError(`the role '${name}' was not found in ${dirs.join(":")}\n\n${where(R, abs, ds)}`);
    if (R.roles[dir]) return R.roles[dir];
    const file = (sub) => [dir + "/" + sub + "/main.yml", dir + "/" + sub + "/main.yaml", dir + "/" + sub + "/main"].find((f) => sim.files[f] !== undefined);
    const load = (sub) => { const f = file(sub); return f ? parseFile(R, f, L.isVaultText(sim.files[f]) ? decryptOrThrow(R, sim.files[f], f) : sim.files[f]) : null; };
    const role = { name, path: dir, defaults: isDict(load("defaults")) ? load("defaults") : {}, vars: isDict(load("vars")) ? load("vars") : {}, tasksFile: file("tasks"), handlersFile: file("handlers") };
    role.tasks = load("tasks") || [];
    role.handlers = load("handlers") || [];
    R.roles[dir] = role;
    return role;
  }

  // Parse a playbook file into plays, checking everything Ansible checks before it runs.
  function loadPlaybook(R, file, seen = []) {
    const sim = R.sim;
    const abs = sim.path(file);
    R.roles = R.roles || {};
    if (sim.files[abs] === undefined) throw new AnsibleError(`the playbook: ${file} could not be found`);
    const data = parseFile(R, abs, sim.files[abs]);
    if (!Array.isArray(data)) throw new AnsibleError(`A playbook must be a list of plays, got a ${data === null ? "NoneType" : isDict(data) ? "AnsibleMapping" : "AnsibleUnicode"} instead\n\n${where(R, abs, data)}`);
    const plays = [];
    const pbdir = abs.slice(0, abs.lastIndexOf("/"));
    R.pbdir = pbdir;
    for (const ds of data) {
      if (!isDict(ds)) throw new AnsibleError(`playbook entries must be either valid plays or 'import_playbook' statements\n\n${where(R, abs, ds)}`);
      const imp = ds.import_playbook || ds["ansible.builtin.import_playbook"];
      if (imp) {
        if (seen.includes(abs)) continue;
        plays.push(...loadPlaybook(R, pbdir + "/" + imp, [...seen, abs]));
        R.pbdir = pbdir;
        continue;
      }
      for (const k of Object.keys(ds)) if (!PLAY_KEYS.has(k)) throw new AnsibleError(`'${k}' is not a valid attribute for a Play\n\n${where(R, abs, ds)}`);
      if (ds.hosts === undefined || ds.hosts === null) throw new AnsibleError(`the field 'hosts' is required but was not set`);
      const inherit = { tags: asList(ds.tags).map(String), when: [], become: ds.become, vars: [], no_log: ds.no_log, delegate_to: undefined, role: null };
      const roles = asList(ds.roles).map((r) => {
        const name = isDict(r) ? r.role || r.name : r;
        const role = loadRole(R, String(name), abs, isDict(r) ? r : ds);
        return { role, tags: isDict(r) ? asList(r.tags).map(String) : [], when: isDict(r) ? asList(r.when) : [], vars: isDict(r) && isDict(r.vars) ? r.vars : null };
      });
      const varsFiles = asList(ds.vars_files).map((f) => {
        const p = sim.path(pbdir + "/" + f);
        if (sim.files[p] === undefined) throw new AnsibleError(`vars file ${f} was not found\nCould not find file on the Ansible Controller.\nIf you are using a module and expect the file to exist on the remote, see the remote_src option`);
        return readVarsFile(R, p);
      });
      const play = {
        ds, abs, dir: pbdir, name: ds.name, roles: roles.map((r) => r.role), vars: isDict(ds.vars) ? ds.vars : {}, varsFiles,
        pre: compileTasks(R, ds.pre_tasks, abs, inherit),
        main: [...roles.flatMap((r) => compileTasks(R, r.role.tasks, r.role.tasksFile || abs, { ...inherit, tags: [...inherit.tags, ...r.tags], when: r.when, vars: r.vars ? [r.vars] : [], role: r.role })), ...compileTasks(R, ds.tasks, abs, inherit)],
        post: compileTasks(R, ds.post_tasks, abs, inherit),
        handlers: [...roles.flatMap((r) => compileTasks(R, r.role.handlers, r.role.handlersFile || abs, { ...inherit, role: r.role })), ...compileTasks(R, ds.handlers, abs, inherit)]
      };
      plays.push(play);
    }
    return plays;
  }

  // Would this task run under --tags/--skip-tags?
  function selected(R, tags) {
    const want = R.tags;
    const skip = R.skipTags;
    const t = new Set(tags);
    if (skip.some((s) => t.has(s) || (s === "tagged" && t.size) || (s === "untagged" && !t.size))) return false;
    if (t.has("always")) return true;
    if (!want.length || want.includes("all")) return !t.has("never");
    return want.some((w) => t.has(w) || (w === "tagged" && t.size) || (w === "untagged" && !t.size));
  }
  const taskTitle = (t) => (t.role ? t.role.name + " : " : "") + (t.name !== undefined && t.name !== null ? String(t.name) : t.action);

  // --- running a playbook --------------------------------------------------------------

  function emptyStats() { return { ok: 0, changed: 0, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 }; }
  function hostState(R, h) {
    return R.hs[h] || (R.hs[h] = { stats: emptyStats(), setFacts: {}, facts: R.sim.factCache[h] || null, failed: false, unreachable: false, notified: [] });
  }

  // Connect once per host and run: SSH, then sudo, then Python.
  function connection(R, name, become, scope) {
    const sim = R.sim;
    const h = sim.hosts[name];
    const look = lookupFor(R, name, scope);
    const val = (k) => { const v = look(k); return v instanceof Undef ? null : v; };
    const addr = String(val("ansible_host") || name);
    const user = String(val("ansible_user") || val("ansible_ssh_user") || R.opts.user || (scope.play && scope.play.ds.remote_user) || sim.cfg("remote_user") || "ops");
    const key = val("ansible_ssh_private_key_file") || val("ansible_private_key_file") || R.opts.key || sim.cfg("private_key_file");
    const target = sim.hosts[sim.network[addr]] || (sim.network[addr] ? null : addr === name ? h : null);
    const ck = name + "|" + user + "|" + addr + "|" + key;
    if (!(ck in R.conn)) R.conn[ck] = sshProblem(sim, target, addr, user, key);
    const problem = R.conn[ck];
    if (problem) return { unreachable: `Failed to connect to the host via ssh: ${problem}` };
    const login = target.logins[user];
    let root = user === "root";
    if (become) {
      const pass = R.becomePass !== undefined ? R.becomePass : val("ansible_become_password") || val("ansible_become_pass");
      if (login.sudo === "none") {
        return { failed: { changed: false, module_stderr: `Sorry, user ${user} is not allowed to execute '/bin/sh -c echo BECOME-SUCCESS-${hex(name, 32)} ; /usr/bin/python3' as root on ${target.name}.\n`, module_stdout: "", msg: "MODULE FAILURE\nSee stdout/stderr for the exact error", rc: 1 } };
      }
      const broken = Object.keys(target.files).find((p) => p.startsWith("/etc/sudoers.d/") && !sudoersValid(target.files[p].content));
      if (broken) return { failed: { changed: false, module_stderr: `>>> ${broken}: syntax error near line 1 <<<\nsudo: parse error in ${broken} near line 1\nsudo: no valid sudoers sources found, quitting\nsudo: error initializing audit plugin sudoers_audit\n`, module_stdout: "", msg: "MODULE FAILURE\nSee stdout/stderr for the exact error", rc: 1 } };
      if (login.sudo === "password") {
        if (pass === null || pass === undefined || pass === "") return { failed: { msg: "Missing sudo password" } };
        if (String(pass) !== String(target.sudoPassword)) return { failed: { msg: "Incorrect sudo password" } };
      }
      root = true;
    }
    const interp = val("ansible_python_interpreter");
    const python = interp && interp !== "auto" && interp !== "auto_silent" ? String(interp) : target.python;
    return { host: target, user, root, addr, python: python && python === target.python ? python : null, wanted: python || "/usr/bin/python3" };
  }

  function moduleFailure(c) {
    return { changed: false, module_stderr: `Shared connection to ${c.addr} closed.\r\n`, module_stdout: `/bin/sh: 1: ${c.wanted}: not found\r\n`, msg: "The module failed to execute correctly, you probably need to set the interpreter.\nSee stdout/stderr for the exact error", rc: 127 };
  }

  // Print one task result line, as the default callback does.
  function report(R, task, host, res, item, delegated) {
    const o = R.o;
    const label = host + (delegated && delegated !== host ? " -> " + delegated : "");
    const censored = task.no_log === true || boolish(task.no_log || false) ? { censored: "the output has been hidden due to the fact that 'no_log: true' was specified for this result", changed: !!res.changed } : null;
    const shown = censored || Object.fromEntries(Object.entries(res).filter(([k]) => !k.startsWith("_") && k !== "diff" && k !== "failed" && k !== "skipped"));
    const itemText = item !== undefined ? ` (item=${censored ? "None" : typeof item.value === "string" ? item.value : pyRepr(item.label !== undefined ? item.label : item.value)})` : "";
    if (R.diff && res.diff && !censored && task.ds && task.ds.diff !== false) printDiff(o, res.diff);
    if (res.unreachable) return o.say(`fatal: [${label}]: UNREACHABLE! => ${pyJson({ changed: false, msg: res.msg, unreachable: true })}`, "bad");
    if (res.failed) {
      const text = item !== undefined ? `failed: [${label}]${itemText} => ${pyJson({ ...shown, ...(censored ? {} : { ansible_loop_var: "item", item: item.value }) })}` : `fatal: [${label}]: FAILED! => ${pyJson(shown)}`;
      o.say(text, "bad");
      if (res._ignored) o.say("...ignoring", "skip");
      return;
    }
    if (res.skipped) {
      if (!R.sim.cfgBool("display_skipped_hosts", true)) return;
      return o.say(`skipping: [${label}]${item !== undefined ? ` => ${itemText.trim()}` : ""}${R.verbosity && item === undefined ? " => " + pyJson(shown) : ""}`, "skip");
    }
    const word = res.changed ? "changed" : "ok";
    if (res._verbose_always && !censored) {
      return o.say(`${word}: [${label}]${item !== undefined ? ` => ${itemText.trim()}` : ""} => ${pyJson(Object.fromEntries(Object.entries(shown).filter(([k]) => k !== "changed" || res.changed)), 4)}`, res.changed ? "changed" : "ok");
    }
    o.say(`${word}: [${label}]${item !== undefined ? ` => ${itemText.trim()}` : ""}${R.verbosity && !res._quiet ? " => " + pyJson(shown) : ""}`, res.changed ? "changed" : "ok");
  }

  function printDiff(o, d) {
    o.say(`--- before${d.before_header ? ": " + d.before_header : ""}`, "dim");
    o.say(`+++ after${d.after_header ? ": " + d.after_header : ""}`, "dim");
    const a = String(d.before || "").replace(/\n$/, "").split("\n");
    const b = String(d.after || "").replace(/\n$/, "").split("\n");
    if (!d.before) a.length = 0;
    // Longest common subsequence, then one hunk with all context.
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const rows = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { rows.push([" ", a[i]]); i++; j++; }
      else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) rows.push(["-", a[i++]]);
      else rows.push(["+", b[j++]]);
    }
    const range = (k) => (k === 1 ? "1" : `${k ? 1 : 0},${k}`);
    o.say(`@@ -${range(n)} +${range(m)} @@`, "dim");
    for (const [s, t] of rows) o.say(s + t, s === "+" ? "ok" : s === "-" ? "bad" : "");
    o.say("");
  }

  function evalWhen(R, conds, look) {
    for (const c of conds) {
      if (typeof c === "boolean") { if (!c) return { skip: true, cond: String(c) }; continue; }
      let v;
      try { v = L.evalExpr(String(c).replace(/^\s*\{\{\s*|\s*\}\}\s*$/g, ""), look); v = L.truthy(v); } catch (e) {
        if (!(e instanceof TemplateError)) throw e;
        return { error: `The conditional check '${c}' failed. The error was: error while evaluating conditional (${c}): ${e.message}. ${e.message}` };
      }
      if (!v) return { skip: true, cond: String(c) };
    }
    return {};
  }

  const undefinedMsg = (R, task, e) => (e.undefinedVar
    ? `The task includes an option with an undefined variable. The error was: ${e.message}. ${e.message}\n\n${where(R, task.abs, task.ds)}`
    : `${e.message}`);

  // Run one task on one host (and one loop item). Returns the result.
  function runOnHost(R, task, host, scope, item) {
    const sim = R.sim;
    const hs = hostState(R, host);
    const local = item !== undefined ? { item: item.value } : {};
    const taskVars = [...(task.vars || []), ...(scope.extraVars || [])];
    const look = lookupFor(R, host, { ...scope, role: task.role, taskVars, local });
    const when = evalWhen(R, task.when, look);
    if (when.error) return { failed: true, msg: when.error + `\n\n${where(R, task.abs, task.ds)}` };
    if (when.skip) return { changed: false, skipped: true, skip_reason: "Conditional result was False", false_condition: when.cond };
    let args;
    try { args = L.renderDeep(task.args, look); } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      return { failed: true, msg: undefinedMsg(R, task, e) };
    }
    for (const [k, v] of Object.entries(args)) if (v === "__omit_place_holder__") delete args[k];
    const spec = SPECS[task.mod.short];
    // Unknown parameters and choices, as the module's argument spec reports them.
    if (!spec.any) {
      const aliases = spec.aliases || {};
      for (const [k, v] of Object.entries(aliases)) if (k in args) { args[v] = args[k]; delete args[k]; }
      const bad = Object.keys(args).filter((k) => !spec.params.includes(k));
      if (bad.length) {
        const al = Object.keys(aliases).sort();
        return { failed: true, changed: false, msg: `Unsupported parameters for (${task.mod.fq}) module: ${bad.sort().join(", ")}. Supported parameters include: ${spec.params.filter((p) => p !== "_raw_params").join(", ")}${al.length ? ` (${al.join(", ")})` : ""}.` };
      }
      if (spec.states && args.state !== undefined && !spec.states.includes(String(args.state))) return { failed: true, changed: false, msg: `value of state must be one of: ${spec.states.join(", ")}, got: ${args.state}` };
    }
    let delegate = null;
    if (task.delegate_to) {
      try { delegate = String(L.render(String(task.delegate_to), look)); } catch (e) { return { failed: true, msg: undefinedMsg(R, task, e) }; }
    }
    const become = task.become !== undefined ? boolish(task.become) : R.become;
    if (spec.local) return modules[task.mod.short](R, { host, look, args, task, scope, hs });
    const runAs = delegate || host;
    if (!R.inv.hosts[runAs] && !sim.hosts[runAs]) return { unreachable: true, msg: `Failed to connect to the host via ssh: ssh: Could not resolve hostname ${runAs}: Name or service not known` };
    const c = connection(R, runAs, become, { ...scope, role: task.role });
    if (c.unreachable) return { unreachable: true, msg: c.unreachable };
    if (c.failed) return { failed: true, ...c.failed };
    if (!spec.noPython && !c.python) return { failed: true, ...moduleFailure(c) };
    const becomeUser = become && (task.ds.become_user || scope.play.ds.become_user || R.opts.becomeUser);
    if (becomeUser && becomeUser !== "root") {
      // Becoming another unprivileged user needs ACLs (setfacl), pipelining, or world-readable temp files.
      const pipelining = sim.cfgBool("pipelining", false, "ssh_connection") || sim.cfgBool("pipelining", false, "connection");
      if (!c.host.packages.acl && !pipelining && !sim.cfgBool("allow_world_readable_tmpfiles", false)) {
        return { failed: true, msg: `Failed to set permissions on the temporary files Ansible needs to create when becoming an unprivileged user (rc: 1, err: chmod: invalid mode: 'A+user:${becomeUser}:rx:allow'\nTry 'chmod --help' for more information.\n}). For information on working around this, see https://docs.ansible.com/ansible-core/2.18/playbook_guide/playbooks_privilege_escalation.html#risks-of-becoming-an-unprivileged-user` };
      }
      c.asUser = String(becomeUser);
    }
    const check = task.ds && task.ds.check_mode !== undefined ? boolish(task.ds.check_mode) : R.check;
    sim.clock += 1000;
    return modules[task.mod.short](R, { R, host, h: c.host, c, look, args, task, scope, hs, check, delegate });
  }

  // Shared by file-writing modules: where a write is allowed, and the result.
  function writeFile(ctx, path, content, mode, owner) {
    const { h, c, check } = ctx;
    if (!c.root && ROOT_PATHS.test(path)) return { failed: true, changed: false, msg: `Destination ${path.slice(0, path.lastIndexOf("/")) || "/"} not writable` };
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (!dirExists(h, dir)) return { failed: true, changed: false, msg: `Destination directory ${dir} does not exist`, checksum: hex(content, 40) };
    // An unquoted mode is a YAML number: 0600 is octal, but 600 is decimal (01130).
    if (typeof mode === "number") mode = "0" + mode.toString(8);
    if (ctx.args.validate) {
      const cmd = String(ctx.args.validate);
      if (!cmd.includes("%s")) return { failed: true, changed: false, msg: "validate must contain %s: " + cmd };
      const tmp = path + ".tmp" + hex(content, 6);
      h.files[tmp] = { content, mode: "0600", owner: "root" };
      const r = hostShell(ctx.R.sim, h, cmd.replace("%s", tmp), { user: c.user, root: c.root });
      delete h.files[tmp];
      if (r.rc !== 0) return { failed: true, changed: false, checksum: hex(content, 40), exit_status: r.rc, msg: "failed to validate", stderr: r.err.replace(/\n$/, ""), stderr_lines: r.err.replace(/\n$/, "").split("\n"), stdout: r.out, stdout_lines: r.out ? r.out.split("\n") : [] };
    }
    const before = h.files[path];
    const changed = !before || before.content !== content || (mode && before.mode !== String(mode));
    const diff = { before: before ? before.content : "", after: content, before_header: path, after_header: ctx.srcHeader || "dynamically generated" };
    if (changed && !check) h.files[path] = { content, mode: mode ? String(mode) : before ? before.mode : "0644", owner: owner || (c.root ? "root" : c.user) };
    return { changed, checksum: hex(content, 40), dest: path, mode: mode !== undefined ? String(mode) : "0644", owner: owner || (c.root ? "root" : c.user), size: content.length, state: "file", diff: changed ? diff : undefined };
  }

  function findSrc(R, ctx, src, kind) {
    const sim = R.sim;
    const role = ctx.task.role;
    const base = ctx.task.abs.slice(0, ctx.task.abs.lastIndexOf("/"));
    const cands = [];
    if (src.startsWith("/") || src.startsWith("~")) cands.push(sim.path(src));
    else {
      if (role) cands.push(`${role.path}/${kind}/${src}`, `${role.path}/${src}`, `${role.path}/tasks/${kind}/${src}`, `${role.path}/tasks/${src}`);
      cands.push(`${R.pbdir}/${kind}/${src}`, `${R.pbdir}/${src}`);
    }
    const hit = cands.find((p) => sim.files[p] !== undefined);
    return hit ? { path: hit } : { error: `Could not find or access '${src}'\nSearched in:\n${cands.map((p) => "\t" + p).join("\n")} on the Ansible Controller.\nIf you are using a module and expect the file to exist on the remote, see the remote_src option` };
  }

  const pkgMissing = (h, n) => (h.os.pkg === "apt" ? { failed: true, changed: false, msg: `No package matching '${n}' is available` } : { failed: true, changed: false, msg: "Failed to install some of the specified packages", failures: [`No package ${n} available.`], rc: 1, results: [] });

  const modules = {
    ping(R, { c }) { return { changed: false, ping: "pong", ansible_facts: { discovered_interpreter_python: c.python } }; },

    setup(R, { host, h, args, hs }) {
      const facts = factsOf(R, h.name, args.gather_subset && asList(args.gather_subset).includes("min") ? "min" : null);
      hs.facts = facts;
      if (args.filter) {
        const re = safeRe("^" + String(args.filter).replace(/^ansible_/, "").replace(/\*/g, ".*") + "$");
        return { changed: false, ansible_facts: Object.fromEntries(Object.entries(facts).filter(([k]) => re.test(k)).map(([k, v]) => ["ansible_" + k, v])) };
      }
      return { changed: false, ansible_facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => ["ansible_" + k, v])), _quiet: host };
    },

    command(R, ctx) { return runCommand(R, ctx, "command"); },
    shell(R, ctx) { return runCommand(R, ctx, "shell"); },
    raw(R, ctx) { return runCommand(R, ctx, "raw"); },

    apt(R, ctx) { return packages(R, ctx, "apt"); },
    dnf(R, ctx) { return packages(R, ctx, "dnf"); },
    yum(R, ctx) { return packages(R, ctx, "dnf"); },
    package(R, ctx) { return packages(R, ctx, ctx.h.os.pkg); },

    service(R, ctx) { return service(R, ctx); },
    systemd(R, ctx) { return service(R, ctx); },
    systemd_service(R, ctx) { return service(R, ctx); },

    copy(R, ctx) {
      const { args } = ctx;
      if (!args.dest) return { failed: true, changed: false, msg: "missing required arguments: dest" };
      let content = args.content;
      if (content === undefined) {
        if (!args.src) return { failed: true, changed: false, msg: "src (or content) is required" };
        const f = findSrc(R, ctx, String(args.src), "files");
        if (f.error) return { failed: true, changed: false, msg: f.error };
        content = R.sim.files[f.path];
        if (L.isVaultText(content)) { try { content = decryptOrThrow(R, content, f.path); } catch (e) { return { failed: true, changed: false, msg: e.message }; } }
        ctx.srcHeader = f.path;
      }
      let dest = String(args.dest);
      if (dest.endsWith("/")) dest += String(args.src || "").split("/").pop();
      const r = writeFile(ctx, dest, typeof content === "string" ? content : pyJson(content), args.mode, args.owner);
      if (!r.failed && !ctx.check && r.changed) afterWrite(R, ctx.h, dest);
      return r;
    },

    template(R, ctx) {
      const { args, look } = ctx;
      if (!args.src || !args.dest) return { failed: true, changed: false, msg: `missing required arguments: ${!args.src ? "src" : "dest"}` };
      const f = findSrc(R, ctx, String(args.src), "templates");
      if (f.error) return { failed: true, changed: false, msg: f.error };
      let text;
      try { text = L.render(R.sim.files[f.path], look, { trimBlocks: args.trim_blocks !== false }); } catch (e) {
        if (!(e instanceof TemplateError)) throw e;
        return { failed: true, changed: false, msg: e.undefinedVar ? `AnsibleUndefinedVariable: ${e.message}. ${e.message}` : e.message };
      }
      text = toText(text);
      ctx.srcHeader = f.path;
      const r = writeFile(ctx, String(args.dest), text, args.mode, args.owner);
      if (!r.failed && !ctx.check && r.changed) afterWrite(R, ctx.h, String(args.dest));
      return r;
    },

    file(R, ctx) {
      const { args, h, c, check } = ctx;
      const path = args.path;
      if (!path) return { failed: true, changed: false, msg: "missing required arguments: path" };
      const state = args.state || (h.files[path] ? "file" : "file");
      if (!c.root && ROOT_PATHS.test(String(path))) return { failed: true, changed: false, msg: `There was an issue creating ${path} as requested: [Errno 13] Permission denied: b'${path}'`, path };
      if (state === "directory") {
        const had = dirExists(h, path);
        if (!had && !check) h.dirs.add(path);
        return { changed: !had, path, state: "directory", mode: args.mode !== undefined ? String(args.mode) : "0755", owner: args.owner || (c.root ? "root" : c.user), diff: { before: had ? "state: directory\n" : "state: absent\n", after: "state: directory\n", before_header: path, after_header: path } };
      }
      if (state === "absent") {
        const had = !!h.files[path] || h.dirs.has(path);
        if (had && !check) { delete h.files[path]; h.dirs.delete(path); }
        return { changed: had, path, state: "absent" };
      }
      if (state === "touch") { if (!h.files[path] && !check) h.files[path] = { content: "", mode: "0644", owner: c.root ? "root" : c.user }; return { changed: true, dest: path, state: "file" }; }
      if (state === "link") { if (!check) h.files[path] = { content: "", link: args.src, mode: "0777", owner: "root" }; return { changed: !h.files[path] || h.files[path].link !== args.src, dest: path, src: args.src, state: "link" }; }
      const f = h.files[path];
      if (!f) return { failed: true, changed: false, msg: `file (${path}) is absent, cannot continue`, path, state: "absent" };
      const changed = args.mode !== undefined && f.mode !== String(args.mode);
      if (changed && !check) f.mode = String(args.mode);
      return { changed, path, state: "file", mode: f.mode, owner: f.owner };
    },

    lineinfile(R, ctx) {
      const { args, h, c, check } = ctx;
      const path = args.path;
      if (!path) return { failed: true, changed: false, msg: "missing required arguments: path" };
      const f = h.files[path];
      if (!f && !boolish(args.create || false)) return { failed: true, changed: false, msg: `Destination ${path} does not exist !`, rc: 257 };
      if (!c.root && ROOT_PATHS.test(String(path))) return { failed: true, changed: false, msg: `The destination directory (${String(path).slice(0, String(path).lastIndexOf("/"))}) is not writable by the current user. Error was: [Errno 13] Permission denied: b'${path}'` };
      const before = f ? f.content : "";
      const lines = before.replace(/\n$/, "").split("\n").filter((l, i, all) => !(i === all.length - 1 && l === "" && !before));
      const re = args.regexp !== undefined ? safeRe(String(args.regexp)) : null;
      const state = args.state || "present";
      let msg = "";
      let out = lines;
      if (state === "absent") {
        out = lines.filter((l) => !(re ? re.test(l) : l === String(args.line)));
        msg = out.length !== lines.length ? `${lines.length - out.length} line(s) removed` : "";
      } else {
        if (args.line === undefined) return { failed: true, changed: false, msg: "line is required with state=present" };
        const line = String(args.line);
        const idx = re ? lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0).pop() : lines.indexOf(line);
        if (idx !== undefined && idx >= 0) {
          if (lines[idx] !== line) { out = [...lines]; out[idx] = line; msg = "line replaced"; }
        } else if (!re || !lines.includes(line)) { out = [...lines, line]; msg = "line added"; }
      }
      const after = out.join("\n") + (out.length ? "\n" : "");
      const changed = after !== before;
      if (changed && !check) { h.files[path] = { ...(f || { mode: "0644", owner: c.root ? "root" : c.user }), content: after }; afterWrite(R, h, path); }
      return { changed, msg, backup: "", diff: changed ? { before, after, before_header: `${path} (content)`, after_header: `${path} (content)` } : undefined };
    },

    user(R, ctx) {
      const { args, h, c, check } = ctx;
      if (!args.name) return { failed: true, changed: false, msg: "missing required arguments: name" };
      const name = String(args.name);
      if (!c.root) return { failed: true, changed: false, name, msg: "useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.\n", rc: 1 };
      const had = h.accounts[name];
      if (args.state === "absent") { if (had && !check) delete h.accounts[name]; return { changed: !!had, force: false, name, remove: false, state: "absent" }; }
      const want = { shell: args.shell || (had ? had.shell : "/bin/sh"), groups: args.groups !== undefined ? (args.append ? [...new Set([...(had ? had.groups : []), ...asList(String(args.groups).split(","))])] : asList(String(args.groups).split(",")).filter(Boolean)) : had ? had.groups : [] };
      const changed = !had || had.shell !== want.shell || had.groups.join() !== want.groups.join() || (args.password !== undefined && had.password !== args.password);
      if (changed && !check) h.accounts[name] = { ...want, password: args.password };
      return { changed, comment: args.comment || "", create_home: args.create_home !== false, group: 1001, home: `/home/${name}`, name, shell: want.shell, state: "present", system: false, uid: 1001 + Object.keys(h.accounts).indexOf(name), ...(args.password !== undefined ? { password: MASKED } : {}) };
    },

    group(R, { args, h, c, check }) {
      if (!c.root) return { failed: true, changed: false, msg: "groupadd: Permission denied.\ngroupadd: cannot lock /etc/group; try again later.\n", name: args.name };
      h.groups = h.groups || [];
      const had = h.groups.includes(args.name);
      if (!had && !check && args.state !== "absent") h.groups.push(args.name);
      return { changed: !had && args.state !== "absent", gid: 1050, name: args.name, state: args.state || "present", system: false };
    },

    debug(R, { args, look, task }) {
      if (args.verbosity && R.verbosity < Number(args.verbosity)) return { changed: false, skipped: true, skipped_reason: "Verbosity threshold not met." };
      if (args.var !== undefined) {
        let v;
        try { v = L.render("{{ " + args.var + " }}", look); } catch (e) { if (!(e instanceof TemplateError)) throw e; v = "VARIABLE IS NOT DEFINED!"; }
        return { changed: false, [args.var]: v, _verbose_always: true };
      }
      return { changed: false, msg: args.msg !== undefined ? args.msg : "Hello world!", _verbose_always: true, _task: task };
    },

    set_fact(R, { args, hs }) {
      const facts = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "cacheable"));
      Object.assign(hs.setFacts, facts);
      return { changed: false, ansible_facts: facts };
    },

    assert(R, { args, look, task }) {
      for (const that of asList(args.that)) {
        const w = evalWhen(R, [that], look);
        if (w.error) return { failed: true, msg: w.error + `\n\n${where(R, task.abs, task.ds)}` };
        if (w.skip) return { failed: true, changed: false, assertion: String(that), evaluated_to: false, msg: args.fail_msg !== undefined ? args.fail_msg : "Assertion failed" };
      }
      return { changed: false, msg: args.success_msg || "All assertions passed", _verbose_always: !args.quiet };
    },

    fail(R, { args }) { return { failed: true, changed: false, msg: args.msg || "Failed as requested from task" }; },

    include_vars(R, ctx) {
      const { args, task, hs } = ctx;
      const file = String(args.file || args._raw_params || "");
      const sim = R.sim;
      const cands = [...(task.role ? [`${task.role.path}/vars/${file}`] : []), `${task.abs.slice(0, task.abs.lastIndexOf("/"))}/vars/${file}`, `${task.abs.slice(0, task.abs.lastIndexOf("/"))}/${file}`, `${R.pbdir}/vars/${file}`, `${R.pbdir}/${file}`];
      const hit = cands.find((p) => sim.files[p] !== undefined);
      if (!hit) return { failed: true, ansible_facts: {}, ansible_included_var_files: [], changed: false, message: `Could not find or access '${file}'\nSearched in:\n${cands.map((p) => "\t" + p).join("\n")} on the Ansible Controller.\nIf you are using a module and expect the file to exist on the remote, see the remote_src option` };
      let data;
      try { data = readVarsFile(R, hit); } catch (e) { return { failed: true, changed: false, message: e.message }; }
      Object.assign(hs.setFacts, args.name ? { [args.name]: data } : data);
      return { changed: false, ansible_facts: data, ansible_included_var_files: [hit] };
    }
  };

  function runCommand(R, ctx, kind) {
    const { args, h, c, check } = ctx;
    let cmd = args.cmd !== undefined ? args.cmd : args._raw_params;
    if (args.argv !== undefined) cmd = asList(args.argv).map((a) => (/[\s'"]/.test(a) ? "'" + String(a).replace(/'/g, "'\\''") + "'" : String(a))).join(" ");
    if (cmd === undefined || cmd === null || String(cmd).trim() === "") return { failed: true, changed: false, msg: "no command given", rc: 256 };
    cmd = String(cmd);
    if (kind === "command" && /[|&;<>$`]/.test(cmd.replace(/'[^']*'|"[^"]*"/g, "")) && !args.argv) {
      // command does not use a shell: operators reach the program as arguments.
      cmd = cmd.replace(/\s*(\|\||&&|>>|[|;>])\s*/g, " '$1' ");
    }
    const start = R.sim.clock;
    const base = { cmd: args.argv ? asList(args.argv).map(String) : kind === "command" ? (shellSplit(cmd) || []).map((t) => (typeof t === "string" ? t : t.op)) : cmd };
    if (args.creates && h.files[args.creates]) return { changed: false, cmd: base.cmd, rc: 0, stdout: `skipped, since ${args.creates} exists`, stdout_lines: [`skipped, since ${args.creates} exists`], stderr: "", stderr_lines: [], msg: "Did not run command since '" + args.creates + "' exists" };
    if (args.removes && !h.files[args.removes]) return { changed: false, cmd: base.cmd, rc: 0, stdout: `skipped, since ${args.removes} does not exist`, stdout_lines: [], stderr: "", stderr_lines: [], msg: "Did not run command since '" + args.removes + "' does not exist" };
    if (check && kind !== "raw") return { changed: false, skipped: true, msg: "Command would have run if not in check mode", skip_reason: "Command would have run if not in check mode" };
    const ctxShell = { user: c.user, root: c.root && !c.asUser, asUser: c.asUser || (c.root ? "root" : c.user), host: ctx.host, R, async: !!(ctx.task.ds && ctx.task.ds.async) };
    let r;
    if (kind === "command") {
      const argv = (shellSplit(cmd) || []).map((t) => (typeof t === "string" ? t : t.op));
      const exe = argv[0] || "";
      r = program(R.sim, h, argv, ctxShell, null);
      if (r.rc === 127 && /not found/.test(r.err)) return { failed: true, changed: false, cmd: base.cmd, msg: `[Errno 2] No such file or directory: b'${exe}'`, rc: 2, stdout: "", stderr: "", stdout_lines: [], stderr_lines: [] };
    } else r = hostShell(R.sim, h, cmd, ctxShell);
    if (r.drop) return { unreachable: true, msg: `Failed to connect to the host via ssh: ${r.drop}` };
    const res = {
      changed: true, cmd: base.cmd, delta: "0:00:00.00" + (3 + (cmd.length % 7)), end: stamp(R.sim.clock + 4), msg: "", rc: r.rc,
      start: stamp(start), stderr: r.err.replace(/\n$/, ""), stderr_lines: r.err ? r.err.replace(/\n$/, "").split("\n") : [], stdout: r.out.replace(/\n$/, ""), stdout_lines: r.out ? r.out.replace(/\n$/, "").split("\n") : []
    };
    if (kind === "raw") return { changed: true, rc: r.rc, stderr: `Shared connection to ${c.addr} closed.\r\n`, stderr_lines: [`Shared connection to ${c.addr} closed.`], stdout: r.out.replace(/\n/g, "\r\n"), stdout_lines: r.out ? r.out.replace(/\n$/, "").split("\n") : [], ...(r.rc ? { failed: true, msg: "non-zero return code" } : {}) };
    if (r.rc !== 0) { res.failed = true; res.msg = "non-zero return code"; }
    return res;
  }

  function packages(R, ctx, mgr) {
    const { args, h, c, check } = ctx;
    if (mgr !== h.os.pkg) {
      return mgr === "apt"
        ? { failed: true, changed: false, msg: "Could not import python modules: apt, apt_pkg. Please install python3-apt package." }
        : { failed: true, changed: false, msg: `Could not import the dnf python module using ${c.python} (${h.os.py} (main, Apr  2 2024, 08:01:23) [GCC 13.2.0]). Please install \`python3-dnf\` package or ensure you have specified the correct ansible_python_interpreter. (attempted ['/usr/libexec/platform-python', '/usr/bin/python3', '/usr/bin/python2', '/usr/bin/python'])`, results: [] };
    }
    const names = asList(args.name).flatMap((n) => String(n).split(",")).map((n) => n.trim()).filter(Boolean);
    const state = String(args.state || "present");
    if (!names.length) {
      if (args.update_cache) return c.root ? { changed: false, cache_update_time: Math.floor(R.sim.clock / 1000), cache_updated: true } : lockError(mgr);
      return { failed: true, changed: false, msg: "one of the following is required: name, package, upgrade, update_cache" };
    }
    const repo = REPO[h.os.family];
    const pins = Object.fromEntries(names.map((n) => { const m = /^([\w.+-]+?)(?:=|-(?=\d))(.+)$/.exec(n); return m && repo[m[1]] ? [m[1], m[2]] : [n.replace(/[=<>].*$/, ""), null]; }));
    const base = Object.keys(pins);
    const missing = base.find((n) => !repo[n]);
    if (missing && state !== "absent") return pkgMissing(h, missing);
    const badPin = base.find((n) => pins[n] && pins[n] !== repo[n] && pins[n] !== h.packages[n]);
    if (badPin) return h.os.pkg === "apt" ? { failed: true, changed: false, msg: `no available installation candidate for ${badPin}=${pins[badPin]}` } : pkgMissing(h, `${badPin}-${pins[badPin]}`);
    const todo = base.filter((n) => (state === "absent" || state === "removed" ? h.packages[n] : !h.packages[n] || (pins[n] && h.packages[n] !== pins[n]) || (state === "latest" && h.packages[n] !== repo[n])));
    if (!todo.length) return { changed: false, cache_update_time: Math.floor(R.sim.clock / 1000), cache_updated: !!args.update_cache };
    if (!c.root) return lockError(mgr);
    if (h.dpkgBroken) return { failed: true, changed: false, msg: `'/usr/bin/apt-get -y -o "Dpkg::Options::=--force-confdef" -o "Dpkg::Options::=--force-confold"       install ${todo.map((n) => `'${n}'`).join(" ")}' failed: E: dpkg was interrupted, you must manually run 'dpkg --configure -a' to correct the problem. \n`, rc: 100 };
    // unattended-upgrades holds the lock for a while; apt waits lock_timeout seconds.
    if (h.aptLock) {
      if (Number(args.lock_timeout === undefined ? 60 : args.lock_timeout) < h.aptLock) return { failed: true, changed: false, msg: "Failed to lock apt for exclusive operation: Failed to lock directory /var/lib/apt/lists/: E:Could not get lock /var/lib/apt/lists/lock. It is held by process 2481 (apt-get)" };
      R.time += h.aptLock;
      h.aptLock = 0;
    }
    if (!check) for (const n of todo) { if (state === "absent" || state === "removed") delete h.packages[n]; else installPackage(h, n, pins[n]); }
    const stdout = mgr === "apt" ? `Reading package lists...\nBuilding dependency tree...\nThe following NEW packages will be installed:\n  ${todo.join(" ")}\n0 upgraded, ${todo.length} newly installed, 0 to remove and 3 not upgraded.\n` : "";
    return mgr === "apt"
      ? { changed: true, cache_update_time: Math.floor(R.sim.clock / 1000), cache_updated: !!args.update_cache, stderr: "", stderr_lines: [], stdout, stdout_lines: stdout.replace(/\n$/, "").split("\n") }
      : { changed: true, msg: "", rc: 0, results: todo.map((n) => `Installed: ${n}-${repo[n].replace(/^\d+:/, "")}.x86_64`) };
  }
  const lockError = (mgr) => (mgr === "apt"
    ? { failed: true, changed: false, msg: "Failed to lock apt for exclusive operation: Failed to lock directory /var/lib/apt/lists/: E:Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)" }
    : { failed: true, changed: false, msg: "This command has to be run under the root user.", results: [] });

  function service(R, ctx) {
    const { args, h, c, check } = ctx;
    const name = args.name && String(args.name).replace(/\.service$/, "");
    if (!name) return { failed: true, changed: false, msg: "missing required arguments: name" };
    const svc = h.services[name];
    if (!svc) {
      if (args.daemon_reload && !args.state && args.enabled === undefined) return { changed: true, name };
      return { failed: true, changed: false, msg: `Could not find the requested service ${name}: host` };
    }
    let changed = false;
    if (args.enabled !== undefined && boolish(args.enabled) !== svc.enabled) {
      if (!c.root) return { failed: true, changed: false, msg: `Unable to enable service ${name}: Failed to enable unit: Access denied\n` };
      if (!check) svc.enabled = boolish(args.enabled);
      changed = true;
    }
    const state = args.state;
    if (state) {
      const needs = state === "restarted" || state === "reloaded" || (state === "started" && !svc.running) || (state === "stopped" && svc.running);
      if (needs) {
        if (!c.root) return { failed: true, changed: false, msg: `Unable to ${state === "restarted" ? "restart" : state === "stopped" ? "stop" : state === "reloaded" ? "reload" : "start"} service ${name}: Failed to ${state.replace(/ed$/, "").replace(/stopp$/, "stop")} ${name}.service: Access denied\nSee system logs and 'systemctl status ${name}.service' for details.\n` };
        if (!check) {
          const r = serviceAction(R.sim, h, name, state);
          if (r.error) return { failed: true, changed: false, msg: `Unable to ${r.verb} service ${name}: ${r.error}` };
        }
        changed = true;
      }
    }
    return { changed, enabled: svc.enabled, name, state: svc.running || (check && state !== "stopped") ? "started" : "stopped", status: { ActiveState: svc.running ? "active" : "inactive", UnitFileState: svc.enabled ? "enabled" : "disabled" } };
  }

  // After a file changes, a scenario may react (the app reads its version file, say).
  function afterWrite(R, h, path) { if (R.sim.scenario.onWrite) R.sim.scenario.onWrite(R.sim, h, path); }

  modules.uri = function uri(R, { args, h, check }) {
    if (!args.url) return { failed: true, changed: false, msg: "missing required arguments: url" };
    const want = asList(args.status_code !== undefined ? args.status_code : 200).map(Number);
    if (check) return { changed: false, skipped: false, msg: "", status: want[0], url: args.url };
    const r = httpGet(R.sim, h, String(args.url));
    if (r.status < 0) return { failed: true, changed: false, elapsed: 0, msg: `Status code was -1 and not [${want.join(", ")}]: Request failed: <urlopen error [Errno 111] Connection refused>`, redirected: false, status: -1, url: args.url };
    if (!want.includes(r.status)) return { failed: true, changed: false, connection: "close", content_length: String(r.body.length), elapsed: 0, msg: `Status code was ${r.status} and not [${want.join(", ")}]: HTTP Error ${r.status}: ${r.status === 503 ? "Service Unavailable" : "Not Found"}`, redirected: false, status: r.status, url: args.url };
    return { changed: false, connection: "close", content_length: String(r.body.length), cookies: {}, cookies_string: "", elapsed: 0, msg: `OK (${r.body.length} bytes)`, redirected: false, status: r.status, url: args.url, ...(args.return_content ? { content: r.body } : {}) };
  };
  modules.stat = function stat(R, { args, h }) {
    const f = h.files[args.path];
    const dir = !f && Object.keys(h.files).some((p) => p.startsWith(args.path + "/"));
    return { changed: false, stat: f || dir ? { exists: true, path: args.path, isdir: dir, isreg: !!f, mode: f ? f.mode : "0755", size: f ? f.content.length : 4096, pw_name: f ? f.owner : "root", checksum: f ? hex(f.content, 40) : undefined } : { exists: false } };
  };
  modules.wait_for = function waitFor(R, { args, h }) {
    const port = Number(args.port);
    const r = httpGet(R.sim, h, `http://localhost:${port}/`);
    if (r.status < 0) return { failed: true, changed: false, elapsed: Number(args.timeout || 300), msg: args.msg || `Timeout when waiting for 127.0.0.1:${port}` };
    return { changed: false, elapsed: 0, port, state: "started", path: null, search_regex: null, match_groups: [], match_groupdict: {} };
  };
  modules.ufw = function ufw(R, { args, h, c, check }) {
    if (!c.root) return { failed: true, changed: false, msg: "ERROR: You need to be root to run this script" };
    h.ufw = h.ufw || [];
    const rule = `${args.rule || "allow"} ${args.port || ""}/${args.proto || "any"}`;
    const had = h.ufw.includes(rule);
    if (!had && !check && args.rule) h.ufw.push(rule);
    if (args.state === "enabled" && !check) h.ufwEnabled = true;
    return { changed: !had || (args.state === "enabled" && !h.ufwEnabled), commands: [`/usr/sbin/ufw status verbose`, `/usr/sbin/ufw ${args.rule || ""} ${args.port || ""}`], msg: "Status: active" };
  };

  // --- the play loop ------------------------------------------------------------------

  function loopItems(R, task, host, scope) {
    const ds = task.ds;
    const key = ds.loop !== undefined ? "loop" : Object.keys(ds).find((k) => /^with_/.test(k));
    if (!key) return null;
    const look = lookupFor(R, host, { ...scope, role: task.role, taskVars: task.vars });
    let v;
    try { v = L.renderDeep(ds[key], look); } catch (e) { if (!(e instanceof TemplateError)) throw e; return { error: e.undefinedVar ? `'${e.message.replace(/^'|' is undefined$/g, "")}' is undefined. ${e.message}` : e.message }; }
    if (key === "with_dict") {
      if (!isDict(v)) return { error: `with_dict expects a dict` };
      v = Object.entries(v).map(([k, x]) => ({ key: k, value: x }));
    } else if (key === "with_items") v = asList(v).flat();
    else if (key === "loop" && !Array.isArray(v)) {
      return { error: `Invalid data passed to 'loop', it requires a list, got this instead: ${pyRepr(v)}. Hint: If you passed a list/dict of just one element, try adding wantlist=True to your lookup invocation or use q/query instead of lookup.` };
    } else v = asList(v);
    const lc = isDict(ds.loop_control) ? ds.loop_control : {};
    return { items: v.map((x) => ({ value: x, label: lc.label !== undefined ? (() => { try { return L.render(String(lc.label), (n) => (n === (lc.loop_var || "item") ? x : look(n))); } catch { return undefined; } })() : undefined })) };
  }

  function finish(R, task, host, res, scope) {
    const hs = hostState(R, host);
    const ds = task.ds;
    if (res.unreachable || res.skipped) return res;
    const register = ds.register;
    const look = () => lookupFor(R, host, { ...scope, role: task.role, taskVars: task.vars, local: register ? { [register]: res } : {} });
    if (ds.changed_when !== undefined && !res.failed) {
      const w = evalWhen(R, asList(ds.changed_when), look());
      if (w.error) return { ...res, failed: true, msg: w.error };
      res.changed = !w.skip;
    }
    if (ds.failed_when !== undefined) {
      const w = evalWhen(R, asList(ds.failed_when), look());
      if (w.error) return { ...res, failed: true, msg: w.error };
      res.failed = !w.skip;
      if (!res.failed) delete res.msg;
      else if (!res.msg) res.msg = "";
      res.failed_when_result = res.failed;
    }
    return res;
  }

  // A notify that names no handler stops the run, as it does in Ansible.
  function notify(R, task, host, play) {
    for (const n of asList(task.ds.notify)) {
      const name = String(n);
      const matches = play.handlers.filter((hd) => hd.name === name || taskTitle(hd) === name || asList(hd.ds.listen).includes(name));
      if (!matches.length) throw new AnsibleError(`The requested handler '${name}' was not found in either the main handlers list nor in the listening handlers list`);
      const hs = hostState(R, host);
      for (const m of matches) if (!hs.notified.includes(m)) hs.notified.push(m);
    }
  }

  // Run a list of tasks over the active hosts of a batch.
  function runTasks(R, tasks, active, scope) {
    for (const task of tasks) {
      if (R.stop) return;
      const live = active.filter((h) => !hostState(R, h).failed && !hostState(R, h).unreachable);
      if (!live.length) return;
      if (task.block) {
        if (!task.block.length && !task.always.length) continue;
        const before = new Set(live.filter((h) => !hostState(R, h).failed));
        runTasks(R, task.block, live, scope);
        const broke = [...before].filter((h) => hostState(R, h).failed);
        if (broke.length && task.rescue.length) {
          for (const h of broke) { const s = hostState(R, h); s.failed = false; s.stats.failed--; s.stats.rescued++; }
          runTasks(R, task.rescue, broke, scope);
        }
        if (task.always.length) {
          const failedNow = live.filter((h) => hostState(R, h).failed);
          for (const h of failedNow) hostState(R, h).failed = false;
          runTasks(R, task.always, live, scope);
          for (const h of failedNow) hostState(R, h).failed = true;
        }
        continue;
      }
      if (!selected(R, task.tags)) continue;
      if (R.startAt && !R.started) {
        if (String(task.name || "") !== R.startAt && taskTitle(task) !== R.startAt) continue;
        R.started = true;
      }
      const short = task.mod.short;
      if (short === "meta") {
        const what = String(task.args._raw_params || "").trim();
        if (what === "flush_handlers") runHandlers(R, scope.play, live, scope);
        else if (what === "end_play") { for (const h of live) hostState(R, h).ended = true; R.endPlay = true; return; }
        else if (what === "clear_facts") for (const h of live) hostState(R, h).facts = null;
        continue;
      }
      banner(R.o, (scope.handler ? "RUNNING HANDLER" : "TASK") + " [" + taskTitle(task) + "]");
      R.record.tasks.push({ title: taskTitle(task), action: task.action, results: {} });
      const rec = R.record.tasks[R.record.tasks.length - 1];
      R.time += Math.ceil(live.length / R.forks) * (short === "apt" || short === "dnf" || short === "package" ? 10 : 2);
      const runOnce = task.ds.run_once === true || boolish(task.ds.run_once || false);
      const hosts = runOnce ? live.slice(0, 1) : live;
      if (short === "include_tasks" || short === "include_role") { includeDynamic(R, task, hosts, scope); continue; }
      for (const host of hosts) {
        const hs = hostState(R, host);
        let res;
        const loop = loopItems(R, task, host, scope);
        if (loop && loop.error) {
          res = { failed: true, msg: loop.error };
          report(R, task, host, res);
        } else if (loop) {
          const results = [];
          for (const item of loop.items) {
            let r = finish(R, task, host, runOnHost(R, task, host, scope, item), scope);
            if (r.unreachable) { res = r; break; }
            r = { ...r, item: item.value, ansible_loop_var: "item" };
            results.push(r);
            const deleg = task.delegate_to ? safeRender(String(task.delegate_to), lookupFor(R, host, { ...scope, local: { item: item.value } })) : null;
            if (!r.failed || !task.ds.ignore_errors) report(R, task, host, r, item, deleg);
            else report(R, task, host, { ...r, _ignored: true }, item, deleg);
          }
          if (!res) {
            const anyFailed = results.some((r) => r.failed);
            const anySkipped = results.length > 0 && results.every((r) => r.skipped);
            res = { changed: results.some((r) => r.changed), failed: anyFailed || undefined, skipped: anySkipped || (!results.length) || undefined, results, msg: anyFailed ? "One or more items failed" : "All items completed", _looped: true };
          } else report(R, task, host, res);
        } else {
          res = finish(R, task, host, runOnHost(R, task, host, scope), scope);
          const deleg = task.delegate_to ? safeRender(String(task.delegate_to), lookupFor(R, host, scope)) : null;
          if (res.failed && boolish(task.ds.ignore_errors || false)) res._ignored = true;
          if (task.ds.async && !res.unreachable && !res.skipped) {
            const jid = `j${parseInt(hex(host + R.sim.clock, 8), 16) % 900000000000 + 100000000000}.${4000 + (R.sim.clock % 900)}`;
            if (Number(task.ds.poll) === 0) Object.assign(res, { ansible_job_id: jid, started: 1, finished: 0, results_file: `/home/deploy/.ansible_async/${jid}` });
            else for (let k = 0; k < 2; k++) R.o.say(`ASYNC POLL on ${host}: jid=${jid} started=1 finished=0`, "dim");
          }
          report(R, task, host, res, undefined, deleg);
        }
        if (task.ds.register && !res.unreachable) {
          const reg = Object.fromEntries(Object.entries(res).filter(([k]) => !k.startsWith("_") && k !== "diff"));
          for (const h of runOnce ? live : [host]) hostState(R, h).setFacts[task.ds.register] = reg;
        }
        if (short === "setup" || short === "gather_facts") hs.facts = hs.facts || factsOf(R, host);
        // Account for the result.
        const targets = runOnce ? live : [host];
        for (const h of targets) {
          const s = hostState(R, h);
          rec.results[h] = res.unreachable ? "unreachable" : res.failed && !res._ignored ? "failed" : res.skipped ? "skipped" : res.changed ? "changed" : "ok";
          if (res.unreachable) { s.stats.unreachable++; s.unreachable = true; continue; }
          if (res.failed && res._ignored) { s.stats.ignored++; s.stats.ok++; continue; }
          if (res.failed) { s.stats.failed++; s.failed = true; continue; }
          if (res.skipped) { s.stats.skipped++; continue; }
          s.stats.ok++;
          if (res.changed) { s.stats.changed++; if (task.ds.notify !== undefined && !scope.handler) notify(R, task, h, scope.play); }
        }
        rec.output = rec.output || [];
        if (res.cmd || res.stdout) rec.output.push(res.stdout || "");
      }
      if (task.ds.any_errors_fatal || (scope.play.ds.any_errors_fatal && live.some((h) => hostState(R, h).failed))) {
        if (live.some((h) => hostState(R, h).failed)) for (const h of active) { const s = hostState(R, h); if (!s.failed && !s.unreachable) { s.failed = true; s.aborted = true; } }
      }
    }
  }
  const safeRender = (s, look) => { try { return String(L.render(s, look)); } catch { return s; } };

  function includeDynamic(R, task, hosts, scope) {
    const short = task.mod.short;
    const groups = new Map();
    for (const host of hosts) {
      const look = lookupFor(R, host, { ...scope, role: task.role, taskVars: task.vars });
      const w = evalWhen(R, task.when, look);
      if (w.skip) { report(R, task, host, { changed: false, skipped: true }); hostState(R, host).stats.skipped++; continue; }
      let args;
      try { args = L.renderDeep(task.args, look); } catch (e) { if (!(e instanceof TemplateError)) throw e; report(R, task, host, { failed: true, msg: undefinedMsg(R, task, e) }); hostState(R, host).stats.failed++; hostState(R, host).failed = true; continue; }
      let key;
      if (short === "include_tasks") {
        const file = resolveTaskFile(R, args.file || args._raw_params, task.abs, task.role);
        if (!file) { report(R, task, host, { failed: true, reason: `Could not find or access '${R.sim.path(R.pbdir + "/" + (args.file || args._raw_params))}' on the Ansible Controller.` }); hostState(R, host).stats.failed++; hostState(R, host).failed = true; continue; }
        key = file;
      } else key = "role:" + args.name;
      if (!groups.has(key)) groups.set(key, { hosts: [], args });
      groups.get(key).hosts.push(host);
    }
    for (const [key, g] of groups) {
      let tasks;
      try {
        if (key.startsWith("role:")) {
          const role = loadRole(R, g.args.name, task.abs, task.ds);
          if (!scope.play.roles.includes(role)) scope.play.roles.push(role);
          tasks = compileTasks(R, role.tasks, role.tasksFile, { tags: task.tags, when: [], become: task.become, vars: task.vars, no_log: task.no_log, role });
          scope.play.handlers.push(...compileTasks(R, role.handlers, role.handlersFile || task.abs, { tags: [], when: [], become: task.become, vars: [], role }));
        } else {
          tasks = compileTasks(R, parseFile(R, key, R.sim.files[key]), key, { tags: [], when: [], become: task.become, vars: task.vars, no_log: task.no_log, role: task.role });
        }
      } catch (e) {
        if (!(e instanceof AnsibleError)) throw e;
        R.o.say(`fatal: [${g.hosts[0]}]: FAILED! => ${pyJson({ reason: e.message })}`, "bad");
        for (const h of g.hosts) { hostState(R, h).stats.failed++; hostState(R, h).failed = true; }
        continue;
      }
      if (!key.startsWith("role:")) R.o.say(`included: ${key} for ${g.hosts.join(", ")}`, "skip");
      for (const h of g.hosts) hostState(R, h).stats.ok++;
      runTasks(R, tasks, g.hosts, scope);
    }
  }

  function runHandlers(R, play, hosts, scope) {
    for (const hd of play.handlers) {
      const who = hosts.filter((h) => {
        const s = hostState(R, h);
        return s.notified.includes(hd) && (!s.failed || R.forceHandlers || play.ds.force_handlers) && !s.unreachable;
      });
      if (!who.length) continue;
      for (const h of who) hostState(R, h).notified = hostState(R, h).notified.filter((x) => x !== hd);
      const failed = who.filter((h) => hostState(R, h).failed);
      for (const h of failed) hostState(R, h).failed = false;
      runTasks(R, [{ ...hd, tags: ["always"] }], who, { ...scope, handler: true });
      for (const h of failed) hostState(R, h).failed = true;
    }
  }

  function gather(R, play, batch, scope) {
    const gf = play.ds.gather_facts;
    const mode = R.sim.cfg("gathering") || "implicit";
    if (gf === false || (gf === undefined && mode === "explicit")) return;
    const subset = asList(play.ds.gather_subset).includes("min") || (R.sim.cfg("gather_subset") || "").includes("min") ? "min" : null;
    const todo = mode === "smart" && gf !== true ? batch.filter((h) => !hostState(R, h).facts) : batch;
    if (!todo.length) return;
    banner(R.o, "TASK [Gathering Facts]");
    R.time += Math.ceil(todo.length / R.forks) * (subset ? 1 : 20);
    R.record.tasks.push({ title: "Gathering Facts", action: "gather_facts", results: {} });
    const rec = R.record.tasks[R.record.tasks.length - 1];
    for (const host of todo) {
      const s = hostState(R, host);
      const become = play.ds.become !== undefined ? boolish(play.ds.become) : R.become;
      const c = connection(R, host, become, scope);
      let res;
      if (c.unreachable) res = { unreachable: true, msg: c.unreachable };
      else if (c.failed) res = { failed: true, ...c.failed };
      else if (!c.python) {
        res = { failed: true, ansible_facts: {}, changed: false, failed_modules: { "ansible.legacy.setup": { ansible_facts: { discovered_interpreter_python: "/usr/bin/python3" }, failed: true, ...moduleFailure(c), warnings: [`No python interpreters found for host ${host} (tried ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3.8', '/usr/bin/python3', 'python3'])`] } }, msg: "The following modules failed to execute: ansible.legacy.setup\n" };
      } else {
        s.facts = factsOf(R, host, subset);
        R.sim.factCache[host] = /jsonfile|memory|redis/.test(R.sim.cfg("fact_caching") || "") ? s.facts : R.sim.factCache[host];
        res = { changed: false };
      }
      report(R, { ds: {}, no_log: false }, host, res.failed || res.unreachable ? res : { changed: false, _quiet: true });
      rec.results[host] = res.unreachable ? "unreachable" : res.failed ? "failed" : "ok";
      if (res.unreachable) { s.stats.unreachable++; s.unreachable = true; }
      else if (res.failed) { s.stats.failed++; s.failed = true; }
      else s.stats.ok++;
    }
  }

  function batches(play, hosts) {
    const serial = play.ds.serial;
    if (serial === undefined || serial === null || serial === 0) return [hosts];
    const sizes = asList(serial).map((s) => (/%$/.test(String(s)) ? Math.max(1, Math.floor(hosts.length * parseFloat(s) / 100)) : Number(s) || hosts.length));
    const out = [];
    let i = 0, k = 0;
    while (i < hosts.length) { const n = sizes[Math.min(k++, sizes.length - 1)]; out.push(hosts.slice(i, i + n)); i += n; }
    return out;
  }

  function runPlay(R, play) {
    const warnings = [];
    let hosts = matchHosts(R, play.ds.hosts, warnings);
    for (const w of warnings) R.o.say(`[WARNING]: Could not match supplied host pattern, ignoring: ${w}`, "warn");
    if (R.limit) hosts = hosts.filter((h) => R.limit.includes(h));
    hosts = hosts.filter((h) => !R.removed.has(h));
    banner(R.o, `PLAY [${play.name !== undefined && play.name !== null ? play.name : asList(play.ds.hosts).join(",")}]`);
    if (!hosts.length) { R.o.say("skipping: no hosts matched", "skip"); return; }
    const list = batches(play, hosts);
    for (const [bi, batch] of list.entries()) {
      if (bi > 0) banner(R.o, `PLAY [${play.name !== undefined && play.name !== null ? play.name : play.ds.hosts}]`);
      const scope = { play, playHosts: batch };
      R.endPlay = false;
      gather(R, play, batch, scope);
      for (const part of [play.pre, play.main, play.post]) {
        const live = batch.filter((h) => !hostState(R, h).unreachable);
        runTasks(R, part, live, scope);
        if (R.stop) return;
        runHandlers(R, play, batch, scope);
        if (R.endPlay || !batch.some((h) => !hostState(R, h).failed && !hostState(R, h).unreachable)) break;
      }
      const bad = batch.filter((h) => hostState(R, h).failed || hostState(R, h).unreachable);
      for (const h of bad) R.removed.add(h);
      const mfp = play.ds.max_fail_percentage;
      if (bad.length === batch.length || (mfp !== undefined && bad.length / batch.length * 100 > Number(mfp))) {
        if (bi < list.length - 1 || bad.length === batch.length) { banner(R.o, "NO MORE HOSTS LEFT", "bad"); R.noMoreHosts = true; }
        return;
      }
    }
  }

  function recap(R) {
    banner(R.o, "PLAY RECAP");
    for (const host of Object.keys(R.hs).sort()) {
      const s = R.hs[host].stats;
      const cls = s.failed || s.unreachable ? "bad" : s.changed ? "changed" : "ok";
      R.o.say(`${host.padEnd(26)} : ${["ok", "changed", "unreachable", "failed", "skipped", "rescued", "ignored"].map((k) => `${k}=${String(s[k]).padEnd(4)}`).join(" ")}`, cls);
    }
    R.o.say("");
  }

  // Passwords for Vault: from files, prompts and ansible.cfg.
  function vaultSources(R, opts) {
    const sim = R.sim;
    const fromFile = (f) => {
      const t = sim.read(f);
      if (t === null) throw new AnsibleError(`The vault password file ${sim.path(f)} was not found`);
      return t.replace(/\n$/, "");
    };
    if (opts.vaultFile) R.secrets.push(fromFile(opts.vaultFile));
    if (opts.vaultId) { const src = String(opts.vaultId).split("@").pop(); if (src !== "prompt") R.secrets.push(fromFile(src)); }
    if (!opts.vaultFile && !opts.vaultId && !opts.askVault && sim.cfg("vault_password_file")) R.secrets.push(fromFile(sim.cfg("vault_password_file")));
  }

  function extraVars(R, list) {
    const out = {};
    for (const e of list) {
      const s = String(e).trim();
      if (s.startsWith("@")) {
        const t = R.sim.read(s.slice(1));
        if (t === null) throw new AnsibleError(`Unable to retrieve file contents\nCould not find or access '${R.sim.path(s.slice(1))}' on the Ansible Controller.\nIf you are using a module and expect the file to exist on the remote, see the remote_src option`);
        Object.assign(out, parseFile(R, R.sim.path(s.slice(1)), L.isVaultText(t) ? decryptOrThrow(R, t, s.slice(1)) : t) || {});
      } else if (s.startsWith("{") || s.startsWith("[")) {
        let v;
        try { v = JSON.parse(s); } catch { try { v = L.parseYaml(s); } catch { throw new AnsibleError(`Invalid extra vars data supplied. '${s}' could not be made into a dictionary`); } }
        if (!isDict(v)) throw new AnsibleError(`Invalid extra vars data supplied. '${s}' could not be made into a dictionary`);
        Object.assign(out, v);
      } else Object.assign(out, L.parseKv(s));
    }
    delete out._raw_params;
    return out;
  }

  function usage(o, tool, bad) {
    o.say(`usage: ${tool} [-h] [--version] [-v] [-k] [--private-key PRIVATE_KEY_FILE] [-u REMOTE_USER] [-c CONNECTION] [-T TIMEOUT] [-b] [-K] [-i INVENTORY] [--list-hosts] [-l SUBSET] [-e EXTRA_VARS] [--vault-password-file VAULT_PASSWORD_FILES] [-f FORKS] [-C] [-D]${tool === "ansible-playbook" ? " [-t TAGS] [--skip-tags SKIP_TAGS] [--syntax-check] [--list-tasks] [--list-tags] playbook [playbook ...]" : " [-m MODULE_NAME] [-a MODULE_ARGS] pattern"}`, "bad");
    o.say(`${tool}: error: ${bad}`, "bad");
    o.status = 2;
  }

  function version(sim, o, tool) {
    o.say(`${tool} [core ${CORE}]\n  config file = ${PROJECT}/ansible.cfg\n  configured module search path = ['${HOME}/.ansible/plugins/modules', '/usr/share/ansible/plugins/modules']\n  ansible python module location = ${HOME}/.venv/lib/python3.12/site-packages/ansible\n  ansible collection location = ${HOME}/.ansible/collections:/usr/share/ansible/collections\n  executable location = ${HOME}/.venv/bin/${tool}\n  python version = 3.12.3 (main, Feb  4 2025, 14:48:35) [GCC 13.3.0] (${HOME}/.venv/bin/python3)\n  jinja version = 3.1.6\n  libyaml = True`);
  }

  // Prompts come first (BECOME, then Vault), then the run itself.
  function withPrompts(R, opts, run) {
    const asks = [];
    if (opts.askPass) return run();
    if (opts.askBecome) asks.push(["BECOME password: ", (s) => { R.becomePass = s; }]);
    if (opts.askVault || (opts.vaultId && /@?prompt$/.test(opts.vaultId))) asks.push(["Vault password: ", (s) => { R.secrets.push(s); }]);
    const step = (k) => {
      if (k >= asks.length) return null;
      return { text: asks[k][0], secret: true, answer: (s) => { asks[k][1](s); const next = step(k + 1); if (next) return { out: [], prompt: next }; const o = new Out(); R.o = o; run(); return { out: o.lines }; } };
    };
    const first = step(0);
    if (first) return { prompt: first };
    run();
    return null;
  }

  function setupRun(sim, opts, o, tool) {
    const R = sim.context(opts, o);
    R.forks = Number(opts.forks || sim.cfg("forks") || 5);
    R.tags = opts.tags ? String(opts.tags).split(",").map((s) => s.trim()).filter(Boolean) : [];
    R.skipTags = opts.skipTags ? String(opts.skipTags).split(",").map((s) => s.trim()).filter(Boolean) : [];
    R.become = !!opts.become || sim.cfgBool("become", false, "privilege_escalation");
    R.removed = new Set();
    R.forceHandlers = !!opts.forceHandlers;
    R.startAt = opts.startAt || null;
    R.record = { tool, line: null, opts, extra: {}, tasks: [], stats: {}, ok: false, error: null, verbosity: R.verbosity, check: R.check, diff: R.diff, limit: opts.limit || null, tags: R.tags, output: "" };
    return R;
  }

  function finishRecord(R, o, start) {
    R.record.stats = Object.fromEntries(Object.entries(R.hs).map(([h, s]) => [h, { ...s.stats }]));
    R.record.ok = !R.record.error && Object.values(R.hs).every((s) => !s.stats.failed && !s.stats.unreachable);
    R.record.time = R.time;
    R.record.output = o.lines.slice(start).map(([t]) => t).join("\n");
    R.sim.runs.push(R.record);
  }

  function ansiblePlaybook(sim, args, o) {
    const opts = parseArgs(args, PLAYBOOK_FLAGS);
    if (opts.version) return version(sim, o, "ansible-playbook");
    if (opts.help) { usage(o, "ansible-playbook", "this playground shows the short usage only"); o.status = 0; return null; }
    if (opts.unknown.length) return usage(o, "ansible-playbook", `unrecognized arguments: ${opts.unknown.join(" ")}`);
    if (opts.missing) return usage(o, "ansible-playbook", `argument ${opts.missing}: expected one argument`);
    if (!opts._.length) return usage(o, "ansible-playbook", "the following arguments are required: playbook");
    if (opts.step) { o.status = 127; o.say("--step asks before every task, which needs a real terminal. Try it in the course lab.", "na"); return null; }
    const R = setupRun(sim, opts, o, "ansible-playbook");
    const start = o.lines.length;
    const run = () => {
      const out = R.o;
      const startHere = out.lines.length;
      try {
        if (R.verbosity) out.say(`Using ${PROJECT}/ansible.cfg as config file`);
        vaultSources(R, opts);
        R.extra = extraVars(R, opts.e);
        R.record.extra = R.extra;
        R.inv = loadInventory(R, opts.inventory ? [opts.inventory] : null);
        for (const h of Object.keys(R.inv.hosts)) inventoryVars(R, h, R.sim.path(opts._[0]).replace(/\/[^/]*$/, ""));
        if (opts.limit) {
          const warn = [];
          R.limit = matchHosts(R, opts.limit, warn);
          for (const w of warn) out.say(`[WARNING]: Could not match supplied host pattern, ignoring: ${w}`, "warn");
          if (!R.limit.length) throw new AnsibleError("Specified inventory, host pattern and/or --limit leaves us with no hosts to target.");
        }
        const plays = opts._.flatMap((f) => loadPlaybook(R, f));
        if (opts.syntax) { out.say(""); out.say(`playbook: ${opts._.join(" ")}`); R.record.ok = true; R.record.syntax = true; sim.runs.push(R.record); return; }
        if (opts.listHosts || opts.listTasks || opts.listTags) return listPlaybook(R, plays, opts);
        for (const play of plays) { runPlay(R, play); if (R.stop) break; }
        recap(R);
        if (sim.cfg("callbacks_enabled") && /timer/.test(sim.cfg("callbacks_enabled"))) {
          const t = Math.round(R.time);
          out.say(`Playbook run took 0 days, ${Math.floor(t / 3600)} hours, ${Math.floor(t / 60) % 60} minutes, ${t % 60} seconds`);
        }
        if (R.forks > 100 && Object.keys(R.hs).length > 100) {
          throw new AnsibleError("A worker was found in a dead state");
        }
        const failed = Object.values(R.hs).some((s) => s.stats.failed);
        const unreach = Object.values(R.hs).some((s) => s.stats.unreachable);
        out.status = failed ? 2 : unreach ? 4 : 0;
      } catch (e) {
        if (!(e instanceof AnsibleError)) throw e;
        out.say(`ERROR! ${e.message}`, "bad");
        out.status = 1;
        R.record.error = e.message;
      }
      finishRecord(R, out, startHere);
      trim(out, startHere);
    };
    return withPrompts(R, opts, run);
  }

  // Very long runs (hundreds of hosts) keep their head and their recap.
  function trim(o, start) {
    const n = o.lines.length - start;
    if (n <= 400) return;
    const head = o.lines.slice(start, start + 200);
    const tail = o.lines.slice(-120);
    o.lines.splice(start, n, ...head, [`... ${n - 320} more lines (the playground shows the start and the end of long runs) ...`, "dim"], ...tail);
  }

  function listPlaybook(R, plays, opts) {
    const o = R.o;
    o.say("");
    o.say(`playbook: ${opts._.join(" ")}`);
    plays.forEach((play, i) => {
      const hosts = matchHosts(R, play.ds.hosts).filter((h) => !R.limit || R.limit.includes(h));
      o.say("");
      o.say(`  play #${i + 1} (${play.ds.hosts}): ${play.name || play.ds.hosts}\tTAGS: [${asList(play.ds.tags).join(", ")}]`);
      if (opts.listHosts) { o.say(`    pattern: ['${play.ds.hosts}']`); o.say(`    hosts (${hosts.length}):`); for (const h of hosts) o.say(`      ${h}`); }
      const flat = (ts) => ts.flatMap((t) => (t.block ? flat([...t.block, ...t.rescue, ...t.always]) : [t]));
      const tasks = flat([...play.pre, ...play.main, ...play.post]).filter((t) => selected(R, t.tags));
      if (opts.listTasks) { o.say("    tasks:"); for (const t of tasks) o.say(`      ${taskTitle(t)}\tTAGS: [${[...new Set(t.tags)].join(", ")}]`); }
      if (opts.listTags) o.say(`      TASK TAGS: [${[...new Set(tasks.flatMap((t) => t.tags))].sort().join(", ")}]`);
    });
    R.record.ok = true;
    R.record.list = true;
    R.sim.runs.push(R.record);
  }

  // --- ansible (ad hoc) -------------------------------------------------------------------

  function adhoc(sim, args, o) {
    const opts = parseArgs(args, ADHOC_FLAGS);
    if (opts.version) return version(sim, o, "ansible");
    if (opts.unknown.length) return usage(o, "ansible", `unrecognized arguments: ${opts.unknown.join(" ")}`);
    if (opts.missing) return usage(o, "ansible", `argument ${opts.missing}: expected one argument`);
    if (!opts._.length) return usage(o, "ansible", "the following arguments are required: pattern");
    const R = setupRun(sim, opts, o, "ansible");
    const run = () => {
      const out = R.o;
      const startHere = out.lines.length;
      try {
        vaultSources(R, opts);
        R.extra = extraVars(R, opts.e);
        R.inv = loadInventory(R, opts.inventory ? [opts.inventory] : null);
        const warn = [];
        let hosts = matchHosts(R, opts._[0], warn);
        for (const w of warn) out.say(`[WARNING]: Could not match supplied host pattern, ignoring: ${w}`, "warn");
        if (opts.limit) hosts = hosts.filter((h) => matchHosts(R, opts.limit).includes(h));
        if (opts.listHosts) { out.say(`  hosts (${hosts.length}):`); for (const h of hosts) out.say(`    ${h}`); return; }
        if (!hosts.length) { out.say("[WARNING]: No hosts matched, nothing to do", "warn"); return; }
        const modName = opts.module || "command";
        const mod = resolveModule(sim, modName);
        if (!mod) throw new AnsibleError(`couldn't resolve module/action '${modName}'. This often indicates a misspelling, missing collection, or incorrect module path.`);
        const spec = SPECS[mod.short];
        const raw = opts.args || "";
        let margs;
        if (spec.free && mod.short !== "include_vars") margs = { _raw_params: raw };
        else if (raw.trim().startsWith("{")) { try { margs = JSON.parse(raw); } catch { margs = L.parseKv(raw); } }
        else margs = L.parseKv(raw);
        if ((mod.short === "command" || mod.short === "shell") && !raw.trim()) throw new AnsibleError(`No argument passed to ${mod.short} module`);
        const task = { ds: {}, abs: PROJECT + "/(ad hoc)", args: margs, mod, action: modName, tags: [], when: [], vars: [], become: undefined, no_log: false };
        const play = { ds: { hosts: opts._[0] }, dir: PROJECT, roles: [], vars: {}, varsFiles: [], handlers: [] };
        R.record.tasks.push({ title: modName, action: modName, results: {} });
        for (const host of hosts) {
          const res = runOnHost(R, task, host, { play, playHosts: hosts });
          hostState(R, host).stats[res.unreachable ? "unreachable" : res.failed ? "failed" : "ok"]++;
          if (res.changed && !res.failed) hostState(R, host).stats.changed++;
          R.record.tasks[0].results[host] = res.unreachable ? "unreachable" : res.failed ? "failed" : res.changed ? "changed" : "ok";
          adhocReport(R, host, res, mod.short, opts.oneLine);
        }
        const failed = Object.values(R.hs).some((s) => s.stats.failed);
        out.status = failed ? 2 : Object.values(R.hs).some((s) => s.stats.unreachable) ? 4 : 0;
      } catch (e) {
        if (!(e instanceof AnsibleError)) throw e;
        out.say(`ERROR! ${e.message}`, "bad");
        out.status = 1;
        R.record.error = e.message;
      }
      finishRecord(R, out, startHere);
    };
    return withPrompts(R, opts, run);
  }

  function adhocReport(R, host, res, short, oneLine) {
    const o = R.o;
    const clean = Object.fromEntries(Object.entries(res).filter(([k]) => !k.startsWith("_") && k !== "diff"));
    if (res.unreachable) return o.say(`${host} | UNREACHABLE! => ${pyJson({ changed: false, msg: res.msg, unreachable: true }, oneLine ? 0 : 4)}`, "bad");
    if ((short === "command" || short === "shell" || short === "raw") && res.rc !== undefined && !res.skipped && res.module_stdout === undefined) {
      const word = res.failed ? "FAILED" : res.changed ? "CHANGED" : "SUCCESS";
      if (oneLine) return o.say(`${host} | ${word} | rc=${res.rc} | (stdout) ${String(res.stdout || "").replace(/\n/g, "\\n")}`, res.failed ? "bad" : res.changed ? "changed" : "ok");
      return o.say(`${host} | ${word} | rc=${res.rc} >>\n${res.stdout || ""}${res.stderr && short !== "raw" ? (res.stdout ? "\n" : "") + res.stderr : ""}${res.failed ? res.msg || "" : ""}`.replace(/\n$/, ""), res.failed ? "bad" : res.changed ? "changed" : "ok");
    }
    const word = res.failed ? "FAILED!" : res.changed ? "CHANGED" : "SUCCESS";
    o.say(`${host} | ${word} => ${pyJson(clean, oneLine ? 0 : 4)}`, res.failed ? "bad" : res.changed ? "changed" : "ok");
  }

  // --- ansible-inventory, ansible-config, ansible-doc -------------------------------------------

  function ansibleInventory(sim, args, o) {
    const opts = parseArgs(args, { ...COMMON, "--list": ["list", 0], "--graph": ["graph", 0], "--host": ["host", 1], "-y": ["yaml", 0], "--yaml": ["yaml", 0], "--vars": ["vars", 0] });
    if (opts.unknown.length) { o.say(`usage: ansible-inventory [-h] [--version] [-v] [-i INVENTORY] [-l SUBSET] [--vault-password-file VAULT_PASSWORD_FILES] [--list] [--host HOST] [--graph] [-y] [--vars] [group]\nansible-inventory: error: unrecognized arguments: ${opts.unknown.join(" ")}`, "bad"); o.status = 2; return null; }
    if (!opts.list && !opts.graph && !opts.host) { o.say("ERROR! No action selected, at least one of --host, --graph or --list needs to be specified.", "bad"); o.status = 5; return null; }
    const R = sim.context(opts, o);
    const run = () => {
      const out = R.o;
      try {
        vaultSources(R, opts);
        R.inv = loadInventory(R, opts.inventory ? [opts.inventory] : null);
        const inv = R.inv;
        const hostVars = (h) => {
          const v = inventoryVars(R, h, PROJECT);
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x instanceof Vaulted ? { __ansible_vault: x.cipher } : x]));
        };
        if (opts.host) {
          if (!inv.hosts[opts.host]) throw new AnsibleError(`You must pass a single valid host to --host parameter`);
          out.say(opts.yaml ? L.toYaml(hostVars(opts.host)).replace(/\n$/, "") : pyJson(hostVars(opts.host), 4));
          return;
        }
        if (opts.graph) {
          const start = opts._[0] || "all";
          if (!inv.groups[start]) throw new AnsibleError(`Pattern must be valid group name when using --graph`);
          out.say(`@${start}:`);
          const walk = (g, pre) => {
            const x = inv.groups[g];
            const kids = g === "all" ? ["ungrouped", ...x.children.filter((c) => c !== "ungrouped")] : x.children;
            for (const c of kids) { out.say(`${pre}|--@${c}:`); walk(c, pre + "|  "); }
            for (const h of (g === "all" ? [] : x.hosts)) {
              out.say(`${pre}|--${h}`);
              if (opts.vars) for (const [k, v] of Object.entries(inv.hosts[h].vars)) out.say(`${pre}|  |--{${k} = ${toText(v)}}`);
            }
          };
          walk(start, "  ");
          return;
        }
        const list = { _meta: { hostvars: Object.fromEntries(Object.keys(inv.hosts).map((h) => [h, hostVars(h)])) } };
        for (const [g, x] of Object.entries(inv.groups)) {
          const entry = {};
          if (x.hosts.length) entry.hosts = x.hosts;
          if (g === "all") entry.children = [...x.children.filter((c) => c !== "ungrouped"), "ungrouped"];
          else if (x.children.length) entry.children = x.children;
          if (Object.keys(entry).length) list[g] = entry;
        }
        out.say(opts.yaml ? L.toYaml({ all: { children: Object.fromEntries(inv.groups.all.children.map((c) => [c, { hosts: Object.fromEntries((inv.groups[c].hosts || []).map((h) => [h, hostVars(h)])) }])) } }).replace(/\n$/, "") : pyJson(list, 4));
      } catch (e) {
        if (!(e instanceof AnsibleError)) throw e;
        out.say(`ERROR! ${e.message}`, "bad");
        out.status = 1;
      }
    };
    return withPrompts(R, opts, run);
  }

  function ansibleConfig(sim, args, o) {
    const verb = args[0];
    const MAP = { inventory: ["DEFAULT_HOST_LIST", (v) => `['${sim.path(v)}']`], roles_path: ["DEFAULT_ROLES_PATH", (v) => `['${sim.path(v)}']`], host_key_checking: ["HOST_KEY_CHECKING", (v) => (boolish(v) ? "True" : "False")], forks: ["DEFAULT_FORKS", (v) => v], interpreter_python: ["INTERPRETER_PYTHON", (v) => v], retry_files_enabled: ["RETRY_FILES_ENABLED", (v) => (boolish(v) ? "True" : "False")], vault_password_file: ["DEFAULT_VAULT_PASSWORD_FILE", (v) => sim.path(v)], gathering: ["DEFAULT_GATHERING", (v) => v], callbacks_enabled: ["CALLBACKS_ENABLED", (v) => `['${v}']`], fact_caching: ["CACHE_PLUGIN", (v) => v], display_skipped_hosts: ["DISPLAY_SKIPPED_HOSTS", (v) => (boolish(v) ? "True" : "False")], remote_user: ["DEFAULT_REMOTE_USER", (v) => v], gather_subset: ["DEFAULT_GATHER_SUBSET", (v) => `['${v}']`] };
    if (verb === "view") { const t = sim.read("ansible.cfg"); o.say(t === null ? "" : t.replace(/\n$/, "")); return null; }
    if (verb === "dump") {
      for (const k of Object.keys(MAP).sort((a, b) => (MAP[a][0] < MAP[b][0] ? -1 : 1))) {
        const v = sim.cfg(k);
        if (v !== null) o.say(`${MAP[k][0]}(${PROJECT}/ansible.cfg) = ${MAP[k][1](v)}`);
        else if (!args.includes("--only-changed")) o.say(`${MAP[k][0]}(default) = ${{ forks: "5", host_key_checking: "True", gathering: "implicit" }[k] || "None"}`, "dim");
      }
      return null;
    }
    if (verb === "list" || verb === "init") { o.say("ansible-config list and init print every setting; see the documentation. This playground supports: ansible-config dump --only-changed, ansible-config view", "na"); o.status = 127; return null; }
    o.say("usage: ansible-config [-h] [--version] [-v] {list,dump,view,init,validate} ...\nansible-config: error: the following arguments are required: action", "bad");
    o.status = 2;
    return null;
  }

  const DOCS = {
    apt: "Manages apt packages (such as for Debian/Ubuntu).", dnf: "Installs, upgrade, removes, and lists packages and groups with the `dnf' package manager.",
    package: "This modules manages packages on a target without specifying a package manager module (like [ansible.builtin.dnf], [ansible.builtin.apt], ...).",
    service: "Controls services on remote hosts. Supported init systems include BSD init, OpenRC, SysV, Solaris SMF, systemd, upstart.", systemd: "Controls systemd units (services, timers, and so on) on remote hosts.",
    copy: "The [ansible.builtin.copy] module copies a file or a directory structure from the local or remote machine to a location on the remote machine.",
    template: "Templates are processed by the Jinja2 templating language.", file: "Set attributes of files, directories, or symlinks and their targets.",
    lineinfile: "This module ensures a particular line is in a file, or replace an existing line using a back-referenced regular expression.",
    user: "Manage user accounts and user attributes.", command: "The [ansible.builtin.command] module takes the command name followed by a list of space-delimited arguments. The given command will be executed on all selected nodes. It will not be processed through the shell, so variables like `$HOSTNAME' and operations like `\"*\"', `\"<\"', `\">\"', `\"|\"', `\";\"' and `\"&\"' will not work.",
    shell: "The [ansible.builtin.shell] module takes the command name followed by a list of space-delimited arguments. It is almost exactly like the [ansible.builtin.command] module but runs the command through a shell (`/bin/sh') on the remote node.",
    raw: "Executes a low-down and dirty SSH command, not going through the module subsystem. This is useful and should only be done in a few cases. A common case is installing `python' on a system without python installed by default.",
    debug: "This module prints statements during execution and can be useful for debugging variables or expressions without necessarily halting the playbook.",
    ping: "A trivial test module, this module always returns `pong' on successful contact. It does not make sense in playbooks, but it is useful from `/usr/bin/ansible' to verify the ability to login and that a usable Python is configured.",
    uri: "Interacts with HTTP and HTTPS web services and supports Digest, Basic and WSSE HTTP authentication mechanisms.", setup: "This module is automatically called by playbooks to gather useful variables about remote hosts that can be used in playbooks.",
    ufw: "Manage firewall with UFW."
  };
  function ansibleDoc(sim, args, o, piped) {
    if (args.includes("-l") || args.includes("--list")) {
      const names = Object.keys(SPECS).filter((m) => !SPECS[m].collection).map((m) => [`ansible.builtin.${m}`, (DOCS[m] || "").split(".")[0]]);
      for (const [c] of Object.entries(sim.collections)) for (const [m, s] of Object.entries(SPECS)) if (s.collection === c) names.push([`${c}.${m}`, (DOCS[m] || "").split(".")[0]]);
      for (const [n, d] of names.sort()) o.say(`${n.padEnd(40)} ${d}`);
      return null;
    }
    const name = args.find((a) => !a.startsWith("-"));
    if (!name) { o.say("usage: ansible-doc [-h] [--version] [-v] [-l] [-s] plugin [plugin ...]\nansible-doc: error: Incorrect options passed", "bad"); o.status = 2; return null; }
    const mod = resolveModule(sim, name);
    if (!mod) { o.say(`[WARNING]: module ${name} not found in:\n${HOME}/.ansible/plugins/modules:/usr/share/ansible/plugins/modules:${HOME}/.venv/lib/python3.12/site-packages/ansible/modules`, "warn"); o.status = 1; return null; }
    const spec = SPECS[mod.short];
    o.say(`> ${mod.fq.toUpperCase()}    (${mod.fq.startsWith("ansible.builtin") ? `${HOME}/.venv/lib/python3.12/site-packages/ansible/modules/${mod.short}.py` : `${HOME}/.ansible/collections/ansible_collections/${mod.fq.split(".").slice(0, 2).join("/")}/plugins/modules/${mod.short}.py`})`);
    o.say("");
    o.say("  " + (DOCS[mod.short] || "See the module documentation."));
    o.say("");
    o.say("OPTIONS (= is mandatory):");
    for (const p of spec.params.filter((x) => x !== "_raw_params")) o.say(`- ${p}`);
    return null;
  }

  // --- ansible-vault ---------------------------------------------------------------------

  function ansibleVault(sim, args, o) {
    const [verb, ...rest] = args;
    const opts = parseArgs(rest, { "--vault-password-file": ["vaultFile", 1], "--vault-pass-file": ["vaultFile", 1], "--vault-id": ["vaultId", 1], "-J": ["askVault", 0], "--ask-vault-pass": ["askVault", 0], "--ask-vault-password": ["askVault", 0], "-n": ["name", 1], "--name": ["name", 1], "--new-vault-password-file": ["newFile", 1], "--output": ["output", 1] });
    const verbs = ["create", "decrypt", "edit", "view", "encrypt", "encrypt_string", "rekey"];
    if (!verbs.includes(verb)) { o.say(`usage: ansible-vault [-h] [--version] [-v] {create,decrypt,edit,view,encrypt,encrypt_string,rekey} ...\nansible-vault: error: argument action: invalid choice: '${verb || ""}' (choose from ${verbs.map((v) => `'${v}'`).join(", ")})`, "bad"); o.status = 2; return null; }
    if (opts.unknown.length) { o.say(`ansible-vault: error: unrecognized arguments: ${opts.unknown.join(" ")}`, "bad"); o.status = 2; return null; }
    const R = sim.context({}, o);
    const err = (m) => { R.o.say(`ERROR! ${m}`, "bad"); R.o.status = 1; };
    let password = null;
    const encrypting = verb === "encrypt" || verb === "encrypt_string" || verb === "create";
    try {
      if (opts.vaultFile) { const t = sim.read(opts.vaultFile); if (t === null) return err(`The vault password file ${sim.path(opts.vaultFile)} was not found`); password = t.replace(/\n$/, ""); }
      else if (opts.vaultId && !/prompt$/.test(opts.vaultId)) { const t = sim.read(String(opts.vaultId).split("@").pop()); if (t === null) return err(`The vault password file ${sim.path(String(opts.vaultId).split("@").pop())} was not found`); password = t.replace(/\n$/, ""); }
      else if (!opts.askVault && sim.cfg("vault_password_file")) { const t = sim.read(sim.cfg("vault_password_file")); if (t !== null) password = t.replace(/\n$/, ""); }
    } catch { return err("Could not read the vault password file"); }
    const act = (pw) => {
      const out = R.o;
      const file = opts._[0];
      if (verb === "encrypt_string") {
        const value = opts._[0];
        if (value === undefined) { out.say("ansible-vault encrypt_string needs the value to encrypt in this playground: ansible-vault encrypt_string 'secret' --name 'db_password'", "na"); return; }
        const enc = L.vaultEncrypt(value, pw);
        out.say(`${opts.name ? opts.name + ": " : ""}!vault |\n${enc.split("\n").map((l) => "          " + l).join("\n")}`);
        out.say("Encryption successful", "stderr");
        return;
      }
      if (!file) { out.say(`ERROR! ansible-vault ${verb} requires at least one filename argument`, "bad"); out.status = 1; return; }
      const text = sim.read(file);
      if (verb === "create") {
        if (text !== null) { out.say(`ERROR! ${file} exists, please use 'edit' instead`, "bad"); out.status = 1; return; }
        R.edit = { path: sim.rel(sim.path(file)), text: "", vault: pw };
        return;
      }
      if (text === null) { out.say(`ERROR! input is not vault encrypted data. ${file} is not a vault encrypted file for ${file}`, "bad"); out.status = 1; return; }
      if (verb === "encrypt") {
        if (L.isVaultText(text)) { out.say("ERROR! input is already encrypted", "bad"); out.status = 1; return; }
        sim.write(file, L.vaultEncrypt(text, pw) + "\n");
        out.say("Encryption successful", "stderr");
        return;
      }
      if (!L.isVaultText(text)) { out.say(`ERROR! input is not vault encrypted data${file} is not a vault encrypted file for ${file}`, "bad"); out.status = 1; return; }
      const plain = L.vaultDecrypt(text, pw);
      if (plain === null) { out.say(`ERROR! Decryption failed (no vault secrets were found that could decrypt) on ${file}`, "bad"); out.status = 1; return; }
      if (verb === "view") out.say(plain.replace(/\n$/, ""));
      else if (verb === "decrypt") { sim.write(file, plain); out.say("Decryption successful", "stderr"); }
      else if (verb === "edit") R.edit = { path: sim.rel(sim.path(file)), text: plain, vault: pw };
      else if (verb === "rekey") {
        const nf = opts.newFile && sim.read(opts.newFile);
        if (!nf) { out.say("ansible-vault rekey needs --new-vault-password-file in this playground", "na"); return; }
        sim.write(file, L.vaultEncrypt(plain, nf.replace(/\n$/, "")) + "\n");
        out.say("Rekey successful", "stderr");
      }
    };
    if (password === null) {
      const confirm = encrypting;
      return { prompt: { text: confirm ? "New Vault password: " : "Vault password: ", secret: true, answer: (pw) => {
        const go = (p) => { const r = new Out(); R.o = r; R.edit = null; act(p); return R.edit ? { out: r.lines, edit: R.edit } : { out: r.lines }; };
        if (!confirm) return go(pw);
        return { out: [], prompt: { text: "Confirm New Vault password: ", secret: true, answer: (again) => {
          if (again !== pw) { const r = new Out(); r.say("ERROR! Passwords do not match", "bad"); return { out: r.lines }; }
          return go(pw);
        } } };
      } } };
    }
    act(password);
    return R.edit ? { edit: R.edit } : null;
  }

  // --- ansible-galaxy ------------------------------------------------------------------

  function ansibleGalaxy(sim, args, o) {
    let [kind, verb, ...rest] = args;
    if (kind === "install" || kind === "list" || kind === "init") { rest = [verb, ...rest].filter((x) => x !== undefined); verb = kind; kind = kind === "install" ? "both" : "role"; }
    const opts = parseArgs(rest, { "-r": ["req", 1], "--requirements-file": ["req", 1], "-p": ["path", 1], "--roles-path": ["path", 1], "--collections-path": ["path", 1], "-f": ["force", 0], "--force": ["force", 0], "--upgrade": ["force", 0], "-U": ["force", 0] });
    const err = (m, code = 1) => { o.say(`ERROR! ${m}`, "bad"); o.status = code; return null; };
    const colDir = (n) => `${HOME}/.ansible/collections/ansible_collections/${n.replace(".", "/")}`;
    if ((kind === "collection" || kind === "role" || kind === "both") && verb === "list") {
      if (kind !== "role") {
        const names = Object.keys(sim.collections).sort();
        if (!names.length) { o.say("[WARNING]: No collections found"); return null; }
        const w = Math.max(10, ...names.map((n) => n.length));
        o.say(`\n# ${HOME}/.ansible/collections/ansible_collections\n${"Collection".padEnd(w)} Version\n${"-".repeat(w)} -------`);
        for (const n of names) o.say(`${n.padEnd(w)} ${sim.collections[n]}`);
      } else {
        const dirs = [...new Set(rolePaths({ sim }, PROJECT).slice(1, -1))];
        for (const d of dirs) { const roles = sim.list(d).filter((r) => sim.isDir(d + "/" + r)); o.say(`# ${d}`); for (const r of roles) o.say(`- ${r}, (unknown version)`); }
      }
      return null;
    }
    if (kind === "role" && verb === "init") {
      const name = opts._[0];
      if (!name) return err("- you must specify a user/role name");
      const base = name.includes("/") ? name : name;
      if (sim.isDir(base)) return err(`- the directory ${sim.path(base)} already exists. You can use --force to re-initialize this directory,\nhowever it will reset any main.yml files that may have\nbeen modified there already.`);
      for (const sub of ["defaults", "handlers", "tasks", "vars", "meta"]) sim.write(`${base}/${sub}/main.yml`, `---\n# ${sub} file for ${base.split("/").pop()}\n`);
      for (const sub of ["files", "templates"]) sim.dirs.add(sim.path(`${base}/${sub}`));
      o.say(`- Role ${base} was created successfully`);
      return null;
    }
    if (verb !== "install") { o.say(`usage: ansible-galaxy [-h] [--version] [-v] TYPE ...\nansible-galaxy: error: argument TYPE: invalid choice: '${kind || ""}' (choose from 'collection', 'role')`, "bad"); o.status = 2; return null; }
    let cols = [];
    let roles = [];
    if (opts.req) {
      const text = sim.read(opts.req);
      if (text === null) return err(`The requirements file '${sim.path(opts.req)}' does not exist.`);
      let data;
      try { data = L.parseYaml(text); } catch (e) { return err(`Failed to parse the requirements yml at '${sim.path(opts.req)}' with the following error:\n${e.message}`); }
      if (Array.isArray(data)) roles = data;
      else if (isDict(data)) { cols = asList(data.collections); roles = asList(data.roles); }
      if (kind === "collection") roles = [];
      if (kind === "role") cols = [];
    } else if (kind === "collection") cols = opts._;
    else roles = opts._;
    if (!cols.length && !roles.length) {
      if (opts.req) { o.say(kind === "collection" ? "Skipping install, no requirements found" : "Starting galaxy role install process\nSkipping install, no requirements found"); return null; }
      return err("- you must specify a user/role name or a roles file");
    }
    if (roles.length) {
      o.say("Starting galaxy role install process");
      for (const r of roles) {
        const name = isDict(r) ? r.name || String(r.src || "").split("/").pop().replace(/\.git$/, "").replace(/^ansible-role-/, "") : String(r);
        const src = isDict(r) ? r.src : r;
        const known = sim.scenario.galaxyRoles && sim.scenario.galaxyRoles[src];
        if (!known) { o.say(`[WARNING]: - ${name} was NOT installed successfully: - sorry, ${src} was not found on https://galaxy.ansible.com/api/.`, "warn"); return err("- you can use --ignore-errors to skip failed roles and finish processing the list."); }
        const dest = sim.path((opts.path || (sim.cfg("roles_path") || "~/.ansible/roles").split(":")[0]) + "/" + name);
        if (sim.isDir(dest) && !opts.force) { o.say(`- ${name} (${(isDict(r) && r.version) || "master"}) is already installed, skipping.`, "warn"); continue; }
        for (const [p, c] of Object.entries(known.files)) sim.write(dest + "/" + p, c);
        o.say(`- extracting ${name} to ${dest}`);
        o.say(`- ${name} (${(isDict(r) && r.version) || "master"}) was installed successfully`);
      }
    }
    if (cols.length) {
      const wanted = cols.map((c) => (isDict(c) ? { name: c.name, version: c.version } : { name: String(c).split(":")[0], version: String(c).split(":")[1] }));
      const missing = wanted.filter((c) => !COLLECTIONS[c.name]);
      if (missing.length) return err(`Failed to resolve the requested dependencies map. Could not satisfy the following requirements:\n${missing.map((c) => `* ${c.name}:${c.version || "*"} (direct request)`).join("\n")}`);
      o.say("Starting galaxy collection install process\nProcess install dependency map\nStarting collection install process");
      for (const c of wanted) {
        const v = c.version && /^\d/.test(String(c.version)) ? String(c.version).replace(/^[<>=!]+/, "") : COLLECTIONS[c.name];
        if (sim.collections[c.name] && !opts.force) { o.say(`Nothing to do. All requested collections are already installed. If you want to reinstall them, consider using \`--force\`.`); continue; }
        o.say(`Downloading https://galaxy.ansible.com/api/v3/plugin/ansible/content/published/collections/artifacts/${c.name.replace(".", "-")}-${v}.tar.gz to ${HOME}/.ansible/tmp/ansible-local-4127x9d/tmpq2n8/${c.name.replace(".", "-")}-${v}-x7k1`);
        o.say(`Installing '${c.name}:${v}' to '${colDir(c.name)}'`);
        sim.collections[c.name] = v;
        o.say(`${c.name}:${v} was installed successfully`, "ok");
      }
    }
    return null;
  }

  root.AQSim = { Sim, HOME, PROJECT, CORE, OS, REPO, SPECS, resolveModule, shellSplit, sedApply, snapshot, confLine, keyText, httpGet, hostShell };
})(typeof window !== "undefined" ? window : globalThis);
