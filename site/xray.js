// Playbook X-ray: explains every line of a playbook or a role's task file and
// flags risky patterns. It reads text only; nothing runs. No DOM access, so
// tests/check_xray.js can load it under Node.
"use strict";

(function (root) {
  const PLAY = {
    name: "The play's name, printed in the PLAY banner. Name every play so the output reads like a log.",
    hosts: "Which hosts this play targets: a group, a host, or a pattern such as `web:!web-02`. --limit narrows it further.",
    become: "Run as another user (root by default) through sudo. On a play it applies to every task; prefer it on the tasks that need it.",
    become_user: "The user become switches to. Defaults to root.",
    gather_facts: "Whether to run the setup module first. false saves time when no task uses facts.",
    gather_subset: "Which facts to gather. `[min]` is fast and still has the OS family and distribution.",
    vars: "Variables for this play. They beat inventory variables but lose to role vars, set_fact and -e.",
    vars_files: "Files of variables to load for this play, often Vault-encrypted.",
    roles: "Roles to apply, in order, before the play's tasks.",
    tasks: "The play's tasks, run in order on every host.",
    pre_tasks: "Tasks that run before the roles.",
    post_tasks: "Tasks that run after the roles and tasks.",
    handlers: "Tasks that run only when notified by a changed task, once, at the end of the section.",
    serial: "Rolling update: how many hosts (or what percentage) go through the whole play at a time. A failed batch stops the rest.",
    max_fail_percentage: "Stop the rolling update when more than this share of a batch fails.",
    any_errors_fatal: "Stop the play on every host as soon as any host fails.",
    strategy: "How tasks are scheduled: linear (all hosts per task) or free (each host at its own pace).",
    force_handlers: "Run notified handlers even if a later task fails, so a changed config is never left unapplied.",
    remote_user: "The SSH user for this play. Inventory ansible_user overrides it.",
    tags: "Tags inherited by everything in the play.",
    environment: "Environment variables set for modules on the hosts.",
    order: "The order hosts are processed: inventory, sorted, reverse_sorted, shuffle.",
    connection: "The connection plugin: ssh by default; local runs on the control node.",
    collections: "Collections searched for short module names. FQCNs are clearer.",
    module_defaults: "Default arguments for modules used in this play.",
    ignore_unreachable: "Continue with a host's other tasks when it was unreachable.",
    import_playbook: "Includes another playbook file at this point, statically."
  };
  const TASK = {
    name: "The task's name, shown in the TASK banner and in --list-tasks. Name every task.",
    when: "A condition; the task is skipped on hosts where it is false. Written as Jinja without {{ }}.",
    loop: "Run the task once per item; the current one is `item`. Needs a list (use dict2items for dictionaries).",
    with_items: "Older loop syntax that flattens lists. loop is the current form.",
    with_dict: "Older loop over a dictionary, giving item.key and item.value. `loop: \"{{ d | dict2items }}\"` is the current form.",
    loop_control: "Options for the loop: label, loop_var, pause.",
    register: "Save this task's result in a variable for later tasks (stdout, rc, changed, results for loops).",
    notify: "Handlers to queue when this task reports changed. Names must match exactly.",
    listen: "A topic this handler responds to, so several tasks can notify it by one name.",
    become: "Run this task as another user through sudo.",
    become_user: "The user to become for this task.",
    changed_when: "When to report changed. `false` for read-only commands; otherwise an expression on the registered result.",
    failed_when: "When to report failure, overriding the module's own judgement.",
    ignore_errors: "Continue even if the task fails. It hides real failures; prefer failed_when or block/rescue.",
    no_log: "Censor this task's result in all output, failures included. Use it on every task that handles a secret.",
    tags: "Labels for --tags and --skip-tags. `always` and `never` are special.",
    delegate_to: "Run this task on another host, while inventory_hostname stays the current one.",
    run_once: "Run on one host of the batch only, and share the result with the others.",
    check_mode: "Force check mode on (true) or off (false) for this task.",
    diff: "Turn diff output on or off for this task.",
    vars: "Variables for this task only.",
    args: "Extra arguments for the module, merged with those given inline.",
    async: "Run the task in the background for up to this many seconds, so no SSH session has to last the whole job.",
    poll: "How often to check an async task, in seconds. 0 means fire and forget.",
    retries: "How many times to retry with until.",
    until: "Retry the task until this condition is true.",
    delay: "Seconds between retries.",
    environment: "Environment variables for this task's module.",
    block: "A group of tasks sharing when, become, tags and error handling.",
    rescue: "Tasks that run only when a task in the block fails: put the rollback here.",
    always: "Tasks that run after the block whether it failed or not: cleanup, restarting services.",
    throttle: "Run this task on at most this many hosts at a time.",
    timeout: "Fail the task if it runs longer than this many seconds.",
    local_action: "Run this module on the control node. delegate_to: localhost is the clearer form.",
    action: "Older way to name the module and its arguments."
  };
  const MODULES = {
    apt: "Manages packages on Debian and Ubuntu.", dnf: "Manages packages on Fedora, RHEL and Rocky.", yum: "Older RHEL package manager; on current systems it calls dnf.",
    package: "Manages packages with whatever package manager the host has; names may still differ by OS.",
    service: "Starts, stops, restarts and enables services.", systemd: "Manages systemd units, including daemon_reload.", systemd_service: "Manages systemd units, including daemon_reload.",
    copy: "Copies a file or inline content to the host, as is (no Jinja rendering).", template: "Renders a Jinja2 template with the host's variables and writes it to the host.",
    file: "Manages files, directories, links and their owner and mode.", lineinfile: "Ensures one line is present (or absent) in a file, replacing a match of regexp.",
    blockinfile: "Ensures a marked block of lines is present in a file.", user: "Manages user accounts.", group: "Manages groups.",
    command: "Runs a program without a shell: no pipes, redirects or variables. Reports changed every time unless told otherwise.",
    shell: "Runs a command through /bin/sh. Reports changed every time unless told otherwise; prefer a module when one exists.",
    raw: "Runs a command over SSH without Python. Use it to bootstrap Python, nothing else.", script: "Copies a local script to the host and runs it.",
    debug: "Prints a message or a variable during the run.", set_fact: "Sets host variables from now on in this run.", assert: "Fails the play when a condition is not true.",
    fail: "Fails the task with a message.", include_vars: "Loads variables from a file at run time.", include_tasks: "Includes a task file at run time (dynamic).",
    import_tasks: "Imports a task file when the playbook loads (static).", include_role: "Runs a role at this point (dynamic).", import_role: "Imports a role at this point (static).",
    meta: "Ansible itself: flush_handlers, end_play, refresh_inventory and similar.", uri: "Makes an HTTP request, for health checks and APIs.",
    get_url: "Downloads a file over HTTP(S) to the host.", unarchive: "Extracts an archive on the host.", stat: "Reads a file's facts: exists, mode, checksum.",
    wait_for: "Waits for a port, a file or a string.", setup: "Gathers facts.", ping: "Tests login and Python.", git: "Checks out a Git repository on the host.",
    pip: "Manages Python packages.", cron: "Manages cron jobs.", mount: "Manages mounts and fstab.", sysctl: "Manages kernel parameters.", reboot: "Reboots the host and waits for it.",
    replace: "Replaces every match of a regular expression in a file.", authorized_key: "Manages SSH authorized keys (ansible.posix).", ufw: "Manages the UFW firewall (community.general).",
    firewalld: "Manages firewalld (ansible.posix).", synchronize: "rsync wrapper (ansible.posix).", apt_repository: "Adds or removes an apt repository.", apt_key: "Manages apt keys (deprecated).",
    docker_container: "Manages Docker containers (community.docker).", import_playbook: "Includes another playbook here, statically.", fetch: "Copies a file from the host to the control node.",
    hostname: "Sets the host name.", timezone: "Sets the time zone (community.general).", pause: "Pauses the play.", add_host: "Adds a host to the in-memory inventory.", group_by: "Creates groups from facts."
  };
  const PARAMS = {
    name: "What the module manages: a package, service or user name, or a list of them.", state: "The state you want: present, absent, started, latest, directory...",
    path: "The file or directory on the host.", dest: "Where the file goes on the host.", src: "The source: in files/ for copy, templates/ for template, or a path.",
    content: "Inline file content, instead of src.", mode: "File permissions. Quote them: \"0644\".", owner: "The file's owner.", group: "The file's group.",
    line: "The exact line that must be in the file.", regexp: "A regular expression for the line to replace (or remove).", insertafter: "Where to add the line if it is missing.",
    create: "Create the file if it does not exist.", backup: "Keep a timestamped copy of the old file.", validate: "A command that checks the new file before it replaces the old (%s is the file).",
    url: "The URL to request or download.", status_code: "The HTTP status codes that count as success.", checksum: "The expected checksum; the download fails if it differs.",
    enabled: "Start at boot.", daemon_reload: "Reload systemd's unit files first.", update_cache: "Refresh the package index first.", cache_valid_time: "Skip the refresh if the cache is younger than this many seconds.",
    cmd: "The command to run.", argv: "The command as a list of arguments: safest, no quoting problems.", chdir: "Change into this directory first.",
    creates: "Skip the command if this path exists: makes it safe to rerun.", removes: "Run the command only if this path exists.",
    msg: "The message.", var: "The variable to print.", verbosity: "Print only at this -v level or higher.", that: "Conditions that must all be true.", fail_msg: "Message when the assertion fails.",
    success_msg: "Message when it passes.", shell: "The user's login shell.", groups: "Extra groups for the user.", append: "Add to the groups instead of replacing them.",
    password: "A password hash (use password_hash). Never plain text.", file: "The file to include or load.", key: "A key.", value: "A value.", remote_src: "The source is already on the host.",
    force: "Replace even if the destination exists.", recurse: "Apply to everything inside the directory.", rule: "allow, deny, limit or reject.", port: "The port.", proto: "The protocol.",
    tasks_from: "Which task file of the role to run.", label: "What to print for each item instead of the whole item.", loop_var: "The name of the loop variable instead of item.",
    body_format: "How to encode the body: json, form-urlencoded or raw.", method: "The HTTP method.", return_content: "Return the response body.", timeout: "Seconds to wait.",
    executable: "The shell to use.", purge: "Also remove configuration files.", autoremove: "Remove packages no longer needed.", only_upgrade: "Upgrade only installed packages.",
    filter: "Only facts matching this pattern.", gather_subset: "Which groups of facts to gather.", src_file: "The source file.", version: "The version to check out or install.",
    repo: "The repository.", extra_args: "Extra command-line arguments.", data: "Data returned by ping.", search_string: "A literal string to find, instead of regexp."
  };
  // Commands that have a module, so shell or command is the wrong tool.
  const MODULE_FOR = [
    [/\b(apt-get|apt|yum|dnf)\s+(-y\s+)?install\b/, "ansible.builtin.apt, dnf or package"], [/\bsystemctl\s+(start|restart|stop|enable|reload)\b|\bservice\s+\S+\s+(start|restart|stop)\b/, "ansible.builtin.service or systemd"],
    [/\buseradd\b|\badduser\b/, "ansible.builtin.user"], [/\bmkdir\b/, "ansible.builtin.file with state: directory"], [/\bchmod\b|\bchown\b/, "ansible.builtin.file with mode and owner"],
    [/>>/, "ansible.builtin.lineinfile or blockinfile"], [/\bsed\s+-i\b/, "ansible.builtin.lineinfile or replace"], [/\bgit\s+clone\b/, "ansible.builtin.git"],
    [/\bpip3?\s+install\b/, "ansible.builtin.pip"], [/\b(curl|wget)\b.*\s-[oO]\b|\bwget\b/, "ansible.builtin.get_url"], [/\btar\s+-?x/, "ansible.builtin.unarchive"],
    [/\bcp\b\s/, "ansible.builtin.copy"], [/\bcrontab\b/, "ansible.builtin.cron"], [/\bln\s+-s\b/, "ansible.builtin.file with state: link"]
  ];
  const SECRET = /(password|passwd|secret|token|api_?key|private_key|credential)/i;
  const LIST_KEYS = new Set(["tasks", "pre_tasks", "post_tasks", "handlers", "block", "rescue", "always"]);

  const shortName = (k) => k.replace(/^(ansible\.(builtin|legacy|posix)|community\.[a-z]+|amazon\.aws|kubernetes\.core)\./, "");
  const strip = (v) => v.replace(/\s+#.*$/, "").trim();

  function explain(text) {
    const raw = String(text).replace(/\r\n?/g, "\n").split("\n");
    if (raw.length > 600) return { error: "The X-ray reads up to 600 lines at a time. Paste one playbook or task file." };
    const isPlaybook = raw.some((l) => /^\s{0,4}(-\s+)?hosts:/.test(l) || /^-\s+(ansible\.builtin\.)?import_playbook:/.test(l));
    const out = [];
    const review = [];
    const stack = []; // {indent, kind}
    const tasks = [];
    let task = null;
    let blockScalar = null;
    const notified = new Set();
    const handlerNames = new Set();
    let inHandlers = false;

    raw.forEach((line, i) => {
      const row = { line, note: "", level: "known", warns: [] };
      out.push(row);
      const indent = line.length - line.trimStart().length;
      const t = line.trim();
      if (blockScalar && (t === "" || indent > blockScalar.indent)) { row.level = t ? "cont" : "blank"; row.note = t ? blockScalar.note : ""; return; }
      blockScalar = null;
      if (!t) { row.level = "blank"; return; }
      if (t.startsWith("#")) { row.note = "A comment: ignored by Ansible."; return; }
      if (t === "---") { row.note = "Marks the start of a YAML document. Optional, but conventional at the top of every file."; return; }
      if (/^\t/.test(line.slice(0, indent + 1)) || line.slice(0, indent).includes("\t")) row.warns.push("Tab in indentation: YAML allows spaces only (found character that cannot start any token).");

      const dash = /^-\s*(.*)$/.exec(t);
      const body = dash ? dash[1] : t;
      const keyIndent = dash ? indent + (t.length - body.length) : indent;
      // An open key ("tasks:") holds deeper lines and a list at its own indent;
      // a mapping (a play, a task) holds keys at its indent and anything deeper.
      const keeps = (e) => (e.open ? indent > e.indent || (dash && indent === e.indent) : indent > e.indent || (!dash && indent === e.indent));
      while (stack.length && !keeps(stack[stack.length - 1])) stack.pop();
      // A list item: what kind depends on the list it belongs to.
      if (dash) {
        const parent = stack[stack.length - 1];
        const kind = !parent ? (isPlaybook ? "play" : "task") : parent.kind === "tasklist" ? "task" : parent.kind === "roles" ? "role" : "item";
        if (kind === "play") { stack.push({ indent: keyIndent, kind: "play" }); inHandlers = false; }
        if (kind === "task") { task = { start: i, rows: [], keys: {}, module: null, inHandlers, indent: keyIndent }; tasks.push(task); stack.push({ indent: keyIndent, kind: "task", task }); }
        if (kind === "role") stack.push({ indent: keyIndent, kind: "rolemap" });
        if (kind === "item") stack.push({ indent: keyIndent, kind: "itemmap" });
        if (!body) { row.note = { play: "A play.", task: "A task.", role: "A role.", item: "One item of the list." }[kind]; return; }
        if (!/^[^\s"'{[][^:]*:(\s|$)/.test(body)) {
          row.note = kind === "role" ? `Applies the role ${body}.` : "One item of the list.";
          checkValue(row, body);
          return;
        }
      }
      const m = /^([^\s:]+|"[^"]*"|'[^']*'):(?:\s+(.*))?$/.exec(body);
      if (!m) { row.note = "Part of the value above (a multi-line string)."; return; }
      const key = m[1].replace(/^["']|["']$/g, "");
      const value = m[2] === undefined ? "" : strip(m[2]);
      const ctx = stack[stack.length - 1] || { kind: isPlaybook ? "play" : "root" };
      const opens = value === "" || /^[|>]/.test(value) || /^!vault/.test(value);
      if (/^[|>]/.test(value) || /^!vault/.test(value)) blockScalar = { indent: keyIndent, note: /^!vault/.test(value) ? "Vault-encrypted text: safe to commit; decrypted only at run time." : "Part of the multi-line value above." };

      let kind = "other";
      if (ctx.kind === "play" && (PLAY[key] !== undefined || key === "ansible.builtin.import_playbook")) {
        row.note = PLAY[key] || PLAY.import_playbook;
        if (LIST_KEYS.has(key)) { kind = "tasklist"; inHandlers = key === "handlers"; }
        else if (key === "roles") kind = "roles";
        else if (key === "vars") kind = "vars";
        if (key === "become" && /^(true|yes)$/i.test(value)) row.warns.push("become on the whole play runs every task as root. Set become on the tasks that need it.");
        if (key === "hosts" && /^(all|\*)$/.test(value.replace(/["']/g, ""))) row.warns.push("Targets every host in the inventory. Make sure that is meant, and preview with --list-hosts.");
      } else if ((ctx.kind === "task" || (ctx.kind === "root" && !isPlaybook)) && (TASK[key] !== undefined)) {
        row.note = TASK[key];
        const tk = ctx.task || task;
        if (tk) tk.keys[key] = value || true;
        if (LIST_KEYS.has(key)) kind = "tasklist";
        else if (key === "vars") kind = "vars";
        else if (key === "loop_control") kind = "params";
        if (key === "ignore_errors" && /^(true|yes)$/i.test(value)) row.warns.push("ignore_errors hides failures, and later tasks run on a broken host. Prefer failed_when, or block with rescue.");
        if (key === "notify") value ? notified.add(value.replace(/^["']|["']$/g, "")) : (kind = "notify");
        if (key === "name" && tk && tk.inHandlers) handlerNames.add(value.replace(/^["']|["']$/g, ""));
        if (key === "listen" && tk) handlerNames.add(value.replace(/^["']|["']$/g, ""));
        if (key === "with_items" || key === "with_dict") row.warns.push("Older loop syntax. Prefer loop: (with dict2items for dictionaries).");
      } else if (ctx.kind === "task" || (ctx.kind === "root" && !isPlaybook)) {
        const short = shortName(key);
        const tk = ctx.task || task;
        if (MODULES[short]) {
          row.note = MODULES[short] + (short === key && !/^(import_playbook)$/.test(key) ? " Written without its collection name; `ansible.builtin." + short + "` (FQCN) is clearer." : "");
          if (tk) tk.module = { name: short, row, value };
          kind = "params";
          moduleChecks(row, short, value);
        } else if (/^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/.test(key)) {
          row.note = `A module from the ${key.split(".").slice(0, 2).join(".")} collection. Install it from requirements.yml; ansible-doc ${key} documents it.`;
          if (tk) tk.module = { name: short, row, value };
          kind = "params";
        } else { row.level = "unknown"; row.note = `Not in the X-ray's dictionary. If it is meant to be a module, Ansible will say "couldn't resolve module/action '${key}'".`; }
      } else if (ctx.kind === "params") {
        row.note = PARAMS[key] || `An option of this module. ansible-doc lists them all.`;
        if (!PARAMS[key]) row.level = "unknown";
        paramChecks(row, key, value, ctx.module);
        if (ctx.module && (ctx.module === "shell" || ctx.module === "command") && (key === "cmd" || key === "_raw_params")) commandChecks(row, value);
        if (ctx.module && /^(creates|removes)$/.test(key) && ctx.task) ctx.task.keys[key] = true;
        if (value === "" && key !== "argv") kind = "params";
      } else if (ctx.kind === "vars" || ctx.kind === "rolemap" || ctx.kind === "itemmap") {
        row.note = ctx.kind === "vars" ? `Sets the variable ${key}.` : ctx.kind === "rolemap" ? ({ role: "Which role to apply.", name: "Which role to apply.", vars: "Variables passed to this role.", tags: "Tags for everything in the role.", when: "Apply the role only where this is true." }[key] || "A setting for this role.") : `The key ${key} of this list item.`;
        if (ctx.kind === "vars") kind = "vars";
        secretLiteral(row, key, value);
      } else {
        row.note = PARAMS[key] || `The key ${key}.`;
        if (!PARAMS[key]) row.level = "unknown";
        secretLiteral(row, key, value);
      }
      checkValue(row, value);
      if (task && SECRET.test(value) && /\{\{/.test(value)) task.usesSecret = true;
      if (opens) stack.push({ open: true, indent: keyIndent, kind: kind === "params" ? "params" : kind, task: ctx.task || task, module: kind === "params" ? (ctx.module || shortName(key)) : ctx.module });
      if (task) task.rows.push(row);
    });

    // Checks that need the whole task.
    for (const tk of tasks) {
      const r = out[tk.start];
      if (!tk.module && !tk.keys.block && !tk.keys.include_tasks) continue;
      if (tk.module && /^(shell|command)$/.test(tk.module.name)) {
        if (!tk.keys.changed_when && !tk.keys.creates && !tk.keys.removes) tk.module.row.warns.push("No changed_when, creates or removes: this task reports changed on every run and fires any handler it notifies.");
        if (tk.module.value) commandChecks(tk.module.row, tk.module.value);
      }
      if (tk.usesSecret && !tk.keys.no_log) (tk.rows.find((x) => SECRET.test(x.line) && /\{\{/.test(x.line)) || r).warns.push("This task handles a secret without no_log: true, so -v output and failures print it.");
      if (tk.module && tk.module.name === "template" && tk.rows.some((x) => /dest:\s*\S*sudoers/.test(x.line)) && !tk.rows.some((x) => /validate:/.test(x.line))) tk.module.row.warns.push("A sudoers file without validate: one typo locks everyone out of sudo. Add validate: visudo -cf %s.");
      if (tk.module && tk.module.name === "get_url" && !tk.rows.some((x) => /checksum:/.test(x.line))) tk.module.row.warns.push("Downloads without checksum: a changed or tampered file is installed silently.");
    }

    const unnamed = tasks.filter((tk) => tk.module && !tk.keys.name && tk.module.name !== "meta").length;
    if (unnamed) review.push(`${unnamed} task${unnamed === 1 ? " has" : "s have"} no name: the output shows only the module, and --start-at-task cannot find ${unnamed === 1 ? "it" : "them"}.`);
    const missing = [...notified].filter((n) => isPlaybook && handlerNames.size && !handlerNames.has(n));
    if (missing.length) review.push(`notify names with no matching handler in this file: ${missing.join(", ")}. Ansible stops with "The requested handler ... was not found" (unless the handler is in a role).`);
    if (isPlaybook && /(state:\s*restarted|state=restarted)/.test(text) && !/\bserial:/.test(text)) review.push("Services are restarted with no serial: every host restarts at the same moment. Consider serial for a rolling update.");
    const short = tasks.filter((tk) => tk.module && tk.module.row.line.trim().replace(/^-\s*/, "").split(":")[0] === tk.module.name).length;
    if (short) review.push(`${short} module${short === 1 ? "" : "s"} written without the collection name (FQCN), such as ansible.builtin.copy.`);
    if (isPlaybook && !/\bno_log:/.test(text) && SECRET.test(text)) review.push("Secrets appear in this file and no task sets no_log.");
    try { root.AQLang.parseYaml(text); } catch (e) { if (e instanceof root.AQLang.YamlError) review.unshift(`YAML error at line ${e.line}, column ${e.col}: ${e.message}. Ansible will not start until it is fixed.`); }
    return { lines: out, review };
  }

  function moduleChecks(row, mod, value) {
    if ((mod === "shell" || mod === "command") && value) commandChecks(row, value);
    if (/state=latest/.test(value)) row.warns.push("state=latest upgrades on every run, to whatever the repository has that day. Pin a version.");
  }
  const CHECKED = new WeakSet();
  function commandChecks(row, cmd) {
    if (CHECKED.has(row)) return;
    CHECKED.add(row);
    if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(cmd)) row.warns.push("Pipes a download straight into a shell: whatever the server sends runs, unreviewed. Download with get_url and a checksum, then run it.");
    const hit = MODULE_FOR.find(([re]) => re.test(cmd));
    if (hit) row.warns.push(`A module does this, idempotently and with check mode: ${hit[1]}.`);
  }
  function paramChecks(row, key, value, mod) {
    if (key === "state" && value === "latest") row.warns.push("state: latest upgrades on every run, to whatever the repository has that day. Pin a version instead.");
    if (key === "mode" && /^\d+$/.test(value)) row.warns.push(value.startsWith("0") ? "Unquoted mode: YAML reads it as octal here, which works, but quote it (\"" + value + "\") to be safe." : `Unquoted mode ${value} is the decimal number ${value}, not octal: the file gets nonsense permissions. Write "0${value}".`);
    if (key === "password" && value && !/\{\{|!vault/.test(value)) row.warns.push("A password in plain text. Keep it in Vault and pass a hash (password_hash).");
    if (key === "validate_certs" && /^(false|no)$/i.test(value)) row.warns.push("Turns off TLS certificate checks: anyone in the middle can answer instead.");
    secretLiteral(row, key, value);
  }
  function secretLiteral(row, key, value) {
    if (SECRET.test(key) && value && !/\{\{|^!vault|lookup\(/.test(value) && !row.warns.some((w) => /plain text/.test(w))) row.warns.push("Looks like a secret in plain text. Encrypt it with ansible-vault encrypt_string, and rotate it if it was ever committed.");
  }
  function checkValue(row, value) {
    if (/^\{\{/.test(value)) row.warns.push("A value starting with {{ must be quoted, or YAML reads it as a dictionary and Ansible stops with 'found unacceptable key'.");
    if (/\bhost_key_checking\b.*false/i.test(value) || /StrictHostKeyChecking=no/.test(value)) row.warns.push("Turns off SSH host key checks for these hosts.");
  }

  root.AQXray = { explain };
})(typeof window !== "undefined" ? window : globalThis);
