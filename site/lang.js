// The languages Ansible reads, small enough to run in a browser: YAML (the
// subset playbooks use, with PyYAML's YAML 1.1 types and error messages),
// INI inventories, Jinja2 expressions and templates, and Vault files.
// No DOM access, so the tests can load it under Node.
"use strict";

(function (root) {
  // --- Python-style printing -------------------------------------------------

  const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Undef) && !(v instanceof Vaulted);
  const pyStr = (s) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") + "'";
  function pyRepr(v) {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "string") return pyStr(v);
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Vaulted) return pyStr(v.cipher);
    if (isDict(v)) return "{" + Object.entries(v).map(([k, x]) => pyStr(k) + ": " + pyRepr(x)).join(", ") + "}";
    return String(v);
  }
  const toText = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "None" : typeof v === "object" ? pyRepr(v) : pyRepr(v));

  // json.dumps(sort_keys=True), on one line or indented by four.
  function pyJson(v, indent, depth = 0) {
    const pad = (d) => (indent ? "\n" + " ".repeat(indent * d) : "");
    if (v === undefined || v instanceof Undef) v = null;
    if (v instanceof Vaulted) v = { __ansible_vault: v.cipher };
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      return "[" + v.map((x) => pad(depth + 1) + pyJson(x, indent, depth + 1)).join(indent ? "," : ", ") + pad(depth) + "]";
    }
    if (isDict(v)) {
      const keys = Object.keys(v).sort();
      if (!keys.length) return "{}";
      return "{" + keys.map((k) => pad(depth + 1) + JSON.stringify(k) + ": " + pyJson(v[k], indent, depth + 1)).join(indent ? "," : ", ") + pad(depth) + "}";
    }
    return JSON.stringify(v);
  }

  // --- YAML --------------------------------------------------------------------

  // Where each mapping started, for "The error appears to be in ..." messages.
  const POS = new WeakMap();
  class Vaulted { constructor(cipher) { this.cipher = cipher; } }
  class YamlError extends Error {
    constructor(problem, line, col, quoteHint) { super(problem); this.line = line; this.col = col; this.quoteHint = quoteHint; }
  }

  function scalar(s) {
    if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(s)) return true;
    if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(s)) return false;
    if (/^(null|Null|NULL|~|)$/.test(s)) return null;
    if (/^[-+]?(0|[1-9][0-9_]*)$/.test(s)) return Number(s.replace(/_/g, ""));
    if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
    if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
    if (/^[-+]?(\.[0-9]+|[0-9][0-9_]*\.[0-9_]*)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s.replace(/_/g, ""));
    return s;
  }

  // Strip a trailing comment that is outside quotes.
  function stripComment(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q && !(q === '"' && s[i - 1] === "\\")) q = null; continue; }
      if ((c === '"' || c === "'") && (i === 0 || /[\s:[{,-]/.test(s[i - 1]))) q = c;
      else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).replace(/\s+$/, "");
    }
    return s.replace(/\s+$/, "");
  }

  function parseQuoted(s, i, line, col) {
    const q = s[i];
    let out = "";
    for (let j = i + 1; j < s.length; j++) {
      const c = s[j];
      if (q === "'" && c === "'") {
        if (s[j + 1] === "'") { out += "'"; j++; continue; }
        return [out, j + 1];
      }
      if (q === '"' && c === "\\") {
        const n = s[++j];
        out += { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/", 0: "\0" }[n] ?? n;
        continue;
      }
      if (q === '"' && c === '"') return [out, j + 1];
      out += c;
    }
    throw new YamlError("found unexpected end of stream", line, col + s.length);
  }

  // Flow collections: [a, b] and {a: 1}. Returns [value, nextIndex].
  function parseFlow(s, i, line, col) {
    const skip = () => { while (s[i] === " ") i++; };
    const plain = (stops) => {
      const start = i;
      while (i < s.length && !stops.includes(s[i]) && !(s[i] === ":" && (s[i + 1] === " " || stops.includes(s[i + 1])))) i++;
      return scalar(s.slice(start, i).trim());
    };
    const value = (stops) => {
      skip();
      if (s[i] === "[" || s[i] === "{") { const [v, n] = parseFlow(s, i, line, col); i = n; return v; }
      if (s[i] === '"' || s[i] === "'") { const [v, n] = parseQuoted(s, i, line, col); i = n; return v; }
      return plain(stops);
    };
    if (s[i] === "[") {
      i++;
      const list = [];
      for (;;) {
        skip();
        if (s[i] === "]") return [list, i + 1];
        if (i >= s.length) throw new YamlError("did not find expected ',' or ']'", line, col + i);
        list.push(value(",]"));
        skip();
        if (s[i] === ",") i++;
        else if (s[i] !== "]") throw new YamlError("did not find expected ',' or ']'", line, col + i);
      }
    }
    i++;
    const map = {};
    for (;;) {
      skip();
      if (s[i] === "}") return [map, i + 1];
      if (i >= s.length) throw new YamlError("did not find expected ',' or '}'", line, col + i);
      if (s[i] === "{") throw new YamlError("found unacceptable key (unhashable type: 'AnsibleMapping')", line, col + i, true);
      const k = value(",}:");
      skip();
      let v = null;
      if (s[i] === ":") { i++; v = value(",}"); }
      map[String(k)] = v;
      skip();
      if (s[i] === ",") i++;
      else if (s[i] !== "}") throw new YamlError("did not find expected ',' or '}'", line, col + i);
    }
  }

  function parseYaml(text, warnings) {
    const lines = [];
    String(text).replace(/\r\n?/g, "\n").split("\n").forEach((raw, n) => {
      const tab = /^[ ]*\t/.exec(raw);
      if (tab) throw new YamlError("found character that cannot start any token", n + 1, tab[0].length);
      const body = stripComment(raw);
      if (!body.trim() || (/^(---|\.\.\.)(\s|$)/.test(body))) { lines.push({ n: n + 1, blank: true, raw }); return; }
      const indent = body.length - body.trimStart().length;
      lines.push({ n: n + 1, indent, text: body.slice(indent), raw });
    });
    let i = 0;
    const next = () => { while (i < lines.length && lines[i].blank) i++; return lines[i]; };

    function blockScalar(head, parentIndent) {
      const fold = head[0] === ">";
      const chomp = head.includes("-") ? "strip" : head.includes("+") ? "keep" : "clip";
      const body = [];
      let ind = null;
      while (i < lines.length) {
        const l = lines[i];
        const lead = l.raw.length - l.raw.trimStart().length;
        if (l.raw.trim() && lead <= parentIndent) break;
        if (l.raw.trim() && ind === null) ind = lead;
        body.push(l.raw.trim() ? l.raw.slice(ind) : "");
        i++;
      }
      while (body.length && body[body.length - 1] === "" && chomp !== "keep") body.pop();
      let out = fold ? body.reduce((acc, l, k) => acc + (k === 0 ? l : (l === "" || body[k - 1] === "" || /^\s/.test(l) ? "\n" : " ") + l), "") : body.join("\n");
      if (chomp !== "strip" && body.length) out += "\n";
      return out;
    }

    // An inline value after "key:" or "- ". Plain scalars may continue on
    // more-indented lines, which is where "mapping values" errors come from.
    function inlineValue(rest, line, col, ownIndent) {
      if (rest.startsWith("!vault")) {
        const head = rest.replace(/^!vault\s*/, "");
        return new Vaulted(blockScalar(head || "|", ownIndent).trim());
      }
      if (rest[0] === "|" || rest[0] === ">") return blockScalar(rest, ownIndent);
      if (rest.startsWith("{{")) throw new YamlError("found unacceptable key (unhashable type: 'AnsibleMapping')", line.n, col, true);
      if (rest[0] === "[" || rest[0] === "{") {
        let s = rest;
        const open = (x) => (x.match(/[[{]/g) || []).length - (x.match(/[\]}]/g) || []).length;
        while (open(s) > 0 && next() && lines[i].indent > ownIndent) { s += " " + lines[i].text; i++; }
        const [v, end] = parseFlow(s, 0, line.n, col);
        if (s.slice(end).trim()) throw new YamlError("did not find expected <document start>", line.n, col + end);
        return v;
      }
      if (rest[0] === '"' || rest[0] === "'") {
        const [v, end] = parseQuoted(rest, 0, line.n, col);
        if (rest.slice(end).trim()) throw new YamlError("did not find expected key", line.n, col + end);
        return v;
      }
      if (rest[0] === "@" || rest[0] === "`") throw new YamlError("found character that cannot start any token", line.n, col);
      let s = rest;
      const bad = /: |:$/.exec(s);
      if (bad) throw new YamlError("mapping values are not allowed in this context", line.n, col + bad.index);
      while (next() && lines[i].indent > ownIndent && !lines[i].text.startsWith("- ")) {
        const l = lines[i];
        const m = /: |:$/.exec(l.text);
        if (m) throw new YamlError("mapping values are not allowed in this context", l.n, l.indent + m.index + 1);
        s += " " + l.text;
        i++;
      }
      return scalar(s);
    }

    function block(minIndent) {
      const l = next();
      if (!l || l.indent < minIndent) return null;
      return /^-( |$)/.test(l.text) ? sequence(l.indent) : mapping(l.indent);
    }

    function sequence(ind) {
      const list = [];
      while (next() && lines[i].indent === ind) {
        const l = lines[i];
        if (!/^-( |$)/.test(l.text)) throw new YamlError("did not find expected '-' indicator", l.n, l.indent + 1);
        const rest = l.text.slice(1).replace(/^ +/, "");
        const col = l.indent + (l.text.length - rest.length) + 1;
        if (!rest) { i++; list.push(block(ind + 1)); continue; }
        if (/^-( |$)/.test(rest) || (/^[^"'[{|>!][^:]*:( |$)/.test(rest) || /^["'][^"']+["']:( |$)/.test(rest))) {
          // "- key: value" or "- - x": a nested collection starting on this line.
          lines[i] = { n: l.n, indent: col - 1, text: rest, raw: l.raw };
          list.push(block(col - 1));
        } else {
          i++;
          list.push(inlineValue(rest, l, col, ind));
        }
      }
      const l = next();
      if (l && l.indent > ind) throw new YamlError("did not find expected '-' indicator", l.n, l.indent + 1);
      return list;
    }

    function mapping(ind) {
      const map = {};
      const first = lines[i];
      POS.set(map, { line: first.n, col: ind + 1 });
      while (next() && lines[i].indent === ind) {
        const l = lines[i];
        if (/^-( |$)/.test(l.text)) throw new YamlError("did not find expected key", l.n, l.indent + 1);
        let key, rest;
        if (l.text[0] === '"' || l.text[0] === "'") {
          const [k, end] = parseQuoted(l.text, 0, l.n, ind + 1);
          key = k;
          rest = l.text.slice(end).replace(/^ *:/, "");
        } else {
          const m = /^([^:]*?)\s*:(?: |$)/.exec(l.text);
          if (!m) {
            const nl = lines.slice(i + 1).find((x) => !x.blank);
            throw new YamlError("could not find expected ':'", nl ? nl.n : l.n, nl ? nl.indent + 1 : l.text.length + ind + 1);
          }
          key = m[1];
          rest = l.text.slice(m[0].length);
        }
        rest = rest.trim();
        if (warnings && Object.prototype.hasOwnProperty.call(map, key)) warnings.push({ key, line: first.n, col: ind + 1 });
        i++;
        const col = ind + l.text.length - rest.length + 1;
        if (!rest) {
          const nx = next();
          map[key] = nx && (nx.indent > ind || (nx.indent === ind && /^-( |$)/.test(nx.text))) ? block(nx.indent) : null;
        } else {
          map[key] = inlineValue(rest, l, col, ind);
        }
      }
      const l = next();
      if (l && l.indent > ind) throw new YamlError("did not find expected key", l.n, l.indent + 1);
      return map;
    }

    const doc = block(0);
    const left = next();
    if (left) throw new YamlError(/^-( |$)/.test(left.text) ? "did not find expected <document start>" : "did not find expected key", left.n, left.indent + 1);
    return doc;
  }

  // "key=value other='two words'": the free-form arguments of k=v module syntax.
  function parseKv(s) {
    const out = {};
    const free = [];
    const re = /(\w+)=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)|(\S+)/g;
    let m;
    while ((m = re.exec(String(s)))) {
      if (m[1]) out[m[1]] = /^["']/.test(m[2]) ? m[2].slice(1, -1) : m[2];
      else free.push(m[3]);
    }
    if (free.length) out._raw_params = free.join(" ");
    return out;
  }

  // "The error appears to be in ..." with the offending line and a caret.
  function whereText(file, text, line, col) {
    const rows = String(text).split("\n");
    const prev = (rows[line - 2] || "").replace(/\s+$/, "");
    return `The error appears to be in '${file}': line ${line}, column ${col}, but may\nbe elsewhere in the file depending on the exact syntax problem.\n\nThe offending line appears to be:\n\n${prev}\n${rows[line - 1] || ""}\n${" ".repeat(Math.max(0, col - 1))}^ here\n`;
  }
  const QUOTE_HINT = "We could be wrong, but this one looks like it might be an issue with\nmissing quotes. Always quote template expression brackets when they\nstart a value. For instance:\n\n    with_items:\n      - {{ foo }}\n\nShould be written as:\n\n    with_items:\n      - \"{{ foo }}\"\n";

  // --- INI inventory -----------------------------------------------------------

  // Values in INI inventories are read like Python literals: 8080 is a number,
  // False is a boolean, but false or yes stay strings.
  function iniValue(v) {
    if (/^["'].*["']$/.test(v)) return v.slice(1, -1);
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d+\.\d+$/.test(v)) return Number(v);
    if (v === "True") return true;
    if (v === "False") return false;
    if (v === "None") return null;
    return v;
  }
  // web-[01:04] expands to web-01 ... web-04.
  function expandRange(name) {
    const m = /^(.*)\[(\d+):(\d+)\](.*)$/.exec(name);
    if (!m) return [name];
    const width = m[2].length;
    const out = [];
    for (let n = Number(m[2]); n <= Number(m[3]); n++) out.push(m[1] + String(n).padStart(width, "0") + m[4]);
    return out;
  }
  function parseIni(text) {
    const inv = { hosts: {}, groups: { all: { hosts: [], children: [], vars: {} }, ungrouped: { hosts: [], children: [], vars: {} } }, errors: [] };
    const group = (g) => inv.groups[g] || (inv.groups[g] = { hosts: [], children: [], vars: {} });
    let section = { name: "ungrouped", kind: "hosts" };
    String(text).split("\n").forEach((raw, n) => {
      const l = raw.replace(/[;#].*$/, "").trim();
      if (!l) return;
      const sec = /^\[([^\]:]+)(?::(vars|children))?\]$/.exec(l);
      if (sec) { section = { name: sec[1], kind: sec[2] || "hosts" }; group(sec[1]); return; }
      if (section.kind === "vars") {
        const m = /^([\w.]+)\s*=\s*(.*)$/.exec(l);
        if (!m) { inv.errors.push(`${n + 1}: Expected key=value, got: ${l}`); return; }
        group(section.name).vars[m[1]] = iniValue(m[2].trim());
        return;
      }
      if (section.kind === "children") { group(section.name).children.push(l); group(l); return; }
      const [name, ...kv] = l.split(/\s+(?=(?:[^"']|"[^"]*"|'[^']*')*$)/);
      for (const h of expandRange(name)) {
        const host = inv.hosts[h] || (inv.hosts[h] = { vars: {} });
        for (const pair of kv) {
          const m = /^([\w.]+)=(.*)$/.exec(pair);
          if (m) host.vars[m[1]] = iniValue(m[2]);
        }
        if (!group(section.name).hosts.includes(h)) group(section.name).hosts.push(h);
      }
    });
    return inv;
  }

  // --- Jinja2 ------------------------------------------------------------------

  // An undefined value carries the message Jinja would raise when it is used.
  class Undef { constructor(msg) { this.msg = msg; } }
  class TemplateError extends Error {
    constructor(msg, undefinedVar) { super(msg); this.undefinedVar = undefinedVar; }
  }
  const TYPE = Symbol("type"); // a Python class name for attribute errors
  const typeName = (v) => (v && v[TYPE]) || (Array.isArray(v) ? "list object" : typeof v === "string" ? "str object" : typeof v === "number" ? "int object" : "dict object");
  const fail = (u) => { throw new TemplateError(u.msg, true); };
  const real = (v) => { if (v instanceof Undef) fail(v); return v; };
  const truthy = (v) => {
    v = real(v);
    if (Array.isArray(v)) return v.length > 0;
    if (isDict(v)) return Object.keys(v).length > 0;
    return Boolean(v);
  };

  const KEYWORDS = new Set(["and", "or", "not", "in", "is", "if", "else", "true", "false", "none", "True", "False", "None"]);
  function lex(src) {
    const toks = [];
    const re = /\s*(?:(\d+\.\d+|\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_][\w]*)|(\*\*|\/\/|==|!=|<=|>=|[-+*/%~|.,:()[\]{}<>=]))/y;
    let m;
    re.lastIndex = 0;
    while (re.lastIndex < src.length) {
      const at = re.lastIndex;
      if (!(m = re.exec(src))) {
        if (/^\s*$/.test(src.slice(at))) break;
        throw new TemplateError(`template error while templating string: unexpected char '${src.slice(at).trim()[0]}' at ${at}. String: {{ ${src} }}`);
      }
      if (m[1]) toks.push({ t: "num", v: Number(m[1]) });
      else if (m[2]) toks.push({ t: "str", v: m[2].slice(1, -1).replace(/\\(.)/g, (x, c) => ({ n: "\n", t: "\t" }[c] || c)) });
      else if (m[3]) toks.push({ t: KEYWORDS.has(m[3]) ? "kw" : "name", v: m[3] });
      else if (m[4]) toks.push({ t: "op", v: m[4] });
    }
    return toks;
  }

  const FILTERS = {
    default: (v, d = "", b = false) => (v instanceof Undef || (b && !truthy(v)) ? d : v),
    mandatory: (v, msg) => (v instanceof Undef ? fail(new Undef(msg || "Mandatory variable has not been overridden")) : v),
    bool: (v) => (typeof v === "boolean" ? v : ["yes", "on", "1", "true"].includes(String(v).toLowerCase())),
    int: (v, d = 0) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; },
    float: (v) => parseFloat(v) || 0,
    string: (v) => toText(v),
    lower: (v) => toText(v).toLowerCase(),
    upper: (v) => toText(v).toUpperCase(),
    capitalize: (v) => { const s = toText(v); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); },
    title: (v) => toText(v).replace(/\b\w/g, (c) => c.toUpperCase()),
    trim: (v) => toText(v).trim(),
    length: (v) => (isDict(v) ? Object.keys(v).length : v.length),
    first: (v) => v[0],
    last: (v) => v[v.length - 1],
    join: (v, sep = "") => v.map(toText).join(sep),
    list: (v) => (typeof v === "string" ? [...v] : isDict(v) ? Object.keys(v) : [...v]),
    unique: (v) => [...new Set(v)],
    sort: (v) => [...v].sort(),
    reverse: (v) => (typeof v === "string" ? [...v].reverse().join("") : [...v].reverse()),
    flatten: (v) => v.flat(Infinity),
    sum: (v) => v.reduce((a, b) => a + b, 0),
    min: (v) => Math.min(...v),
    max: (v) => Math.max(...v),
    abs: (v) => Math.abs(v),
    round: (v, p = 0) => Number(Number(v).toFixed(p)),
    dict2items: (v) => {
      if (!isDict(v)) throw new TemplateError(`dict2items requires a dictionary, got ${typeName(v).replace(" object", "")} instead.`);
      return Object.entries(v).map(([key, value]) => ({ key, value }));
    },
    items2dict: (v) => Object.fromEntries(v.map((x) => [x.key, x.value])),
    combine: (...ds) => Object.assign({}, ...ds),
    to_json: (v) => pyJson(v),
    to_nice_json: (v) => pyJson(v, 4),
    from_json: (v) => JSON.parse(v),
    to_nice_yaml: (v) => toYaml(v),
    quote: (v) => "'" + toText(v).replace(/'/g, "'\"'\"'") + "'",
    replace: (v, a, b) => toText(v).split(a).join(b),
    regex_replace: (v, re, to = "") => toText(v).replace(new RegExp(re, "g"), to.replace(/\\(\d)/g, "$$$1")),
    regex_search: (v, re) => { const m = new RegExp(re).exec(toText(v)); return m ? m[0] : null; },
    split: (v, sep) => (sep === undefined ? toText(v).trim().split(/\s+/) : toText(v).split(sep)),
    b64encode: (v) => b64(toText(v)),
    b64decode: (v) => unb64(toText(v)),
    basename: (v) => toText(v).split("/").pop(),
    dirname: (v) => toText(v).split("/").slice(0, -1).join("/"),
    ternary: (v, a, b) => (truthy(v) ? a : b),
    password_hash: (v, kind = "sha512") => `$6$rounds=656000$${hashHex(toText(v)).slice(0, 16)}$${hashHex("p" + toText(v)).repeat(2).slice(0, 43)}`.replace("$6$", kind === "sha256" ? "$5$" : "$6$"),
    map: (v, name, ...args) => {
      if (isDict(name) && "attribute" in name) return v.map((x) => getattr(x, name.attribute));
      return v.map((x) => callFilter(name, [x, ...args]));
    },
    select: (v, test, ...args) => v.filter((x) => (test ? callTest(test, x, args) : truthy(x))),
    reject: (v, test, ...args) => v.filter((x) => !(test ? callTest(test, x, args) : truthy(x))),
    selectattr: (v, attr, test, ...args) => v.filter((x) => (test ? callTest(test, getattr(x, attr), args) : truthy(getattr(x, attr)))),
    rejectattr: (v, attr, test, ...args) => v.filter((x) => !(test ? callTest(test, getattr(x, attr), args) : truthy(getattr(x, attr)))),
    dictsort: (v) => Object.entries(v).sort(),
    items: (v) => Object.entries(v)
  };
  FILTERS.d = FILTERS.default;
  FILTERS.count = FILTERS.length;
  const LAZY = new Set(["default", "d", "mandatory"]);

  const TESTS = {
    defined: (v) => !(v instanceof Undef),
    undefined: (v) => v instanceof Undef,
    none: (v) => v === null,
    string: (v) => typeof v === "string",
    number: (v) => typeof v === "number",
    integer: (v) => Number.isInteger(v),
    boolean: (v) => typeof v === "boolean",
    true: (v) => v === true,
    false: (v) => v === false,
    mapping: (v) => isDict(v),
    iterable: (v) => Array.isArray(v) || isDict(v) || typeof v === "string",
    sequence: (v) => Array.isArray(v) || typeof v === "string",
    eq: (v, x) => v === x,
    equalto: (v, x) => v === x,
    in: (v, x) => (Array.isArray(x) || typeof x === "string" ? x.includes(v) : isDict(x) && v in x),
    changed: (v) => isDict(v) && v.changed === true,
    failed: (v) => isDict(v) && v.failed === true,
    succeeded: (v) => isDict(v) && !v.failed,
    success: (v) => isDict(v) && !v.failed,
    skipped: (v) => isDict(v) && v.skipped === true,
    match: (v, re) => new RegExp("^(?:" + re + ")").test(toText(v)),
    search: (v, re) => new RegExp(re).test(toText(v)),
    version: (v, other, op = "eq") => {
      const a = String(v).split(".").map(Number);
      const b = String(other).split(".").map(Number);
      let c = 0;
      for (let k = 0; k < Math.max(a.length, b.length) && !c; k++) c = (a[k] || 0) - (b[k] || 0);
      return { "<": c < 0, lt: c < 0, "<=": c <= 0, le: c <= 0, ">": c > 0, gt: c > 0, ">=": c >= 0, ge: c >= 0, "==": c === 0, eq: c === 0, "!=": c !== 0, ne: c !== 0 }[op];
    }
  };

  function callFilter(name, args) {
    const short = name.replace(/^ansible\.builtin\./, "");
    const f = FILTERS[short];
    if (!f) throw new TemplateError(`template error while templating string: Could not load "${name}": '${name}'. String: {{ x | ${name} }}. Could not load "${name}": '${name}'`);
    if (!LAZY.has(short)) args = args.map(real);
    return f(...args);
  }
  function callTest(name, v, args) {
    const t = TESTS[name.replace(/^ansible\.builtin\./, "")];
    if (!t) throw new TemplateError(`template error while templating string: Could not load "${name}": '${name}'`);
    if (name !== "defined" && name !== "undefined") v = real(v);
    return t(v, ...args.map(real));
  }

  // The Python methods templates call on dicts and strings.
  const METHODS = {
    dict: { items: (o) => () => Object.entries(o), keys: (o) => () => Object.keys(o), values: (o) => () => Object.values(o), get: (o) => (k, d = null) => (k in o ? o[k] : d) },
    str: {
      split: (o) => (sep) => (sep === undefined ? o.trim().split(/\s+/) : o.split(sep)), strip: (o) => () => o.trim(), lower: (o) => () => o.toLowerCase(),
      upper: (o) => () => o.toUpperCase(), startswith: (o) => (x) => o.startsWith(x), endswith: (o) => (x) => o.endsWith(x), replace: (o) => (a, b) => o.split(a).join(b)
    }
  };
  function getattr(obj, key) {
    if (obj instanceof Undef) return obj;
    const methods = isDict(obj) && !obj[TYPE] ? METHODS.dict : typeof obj === "string" ? METHODS.str : null;
    if (methods && typeof key === "string" && methods[key] && !(isDict(obj) && key in obj)) return methods[key](obj);
    if (obj !== null && obj !== undefined && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    if (Array.isArray(obj) && typeof key === "number") return key < obj.length ? obj[key] : new Undef(`list object has no element ${key}`);
    if (typeof obj === "string" && typeof key === "number") return obj[key];
    if (obj && typeof obj.get === "function" && obj[TYPE]) { const v = obj.get(key); if (v !== undefined) return v; }
    return new Undef(`'${typeName(obj)}' has no attribute '${key}'`);
  }

  // Parse an expression into a function of the variable lookup.
  function compile(src) {
    const toks = lex(src);
    let p = 0;
    const peek = (v) => toks[p] && toks[p].v === v && toks[p].t !== "str";
    const take = (v) => { if (peek(v)) { p++; return true; } return false; };
    const expect = (v) => { if (!take(v)) throw new TemplateError(`template error while templating string: expected token '${v}', got '${toks[p] ? toks[p].v : "end of print statement"}'. String: {{ ${src} }}`); };
    const name = () => { const tk = toks[p++]; if (!tk || (tk.t !== "name" && tk.t !== "kw")) throw new TemplateError(`template error while templating string: expected name. String: {{ ${src} }}`); return tk.v; };

    function args() {
      const pos = [];
      const kw = {};
      while (!peek(")")) {
        if (toks[p] && toks[p].t === "name" && toks[p + 1] && toks[p + 1].v === "=") { const k = name(); p++; kw[k] = cond(); }
        else pos.push(cond());
        if (!take(",")) break;
      }
      expect(")");
      return (ctx) => { const a = pos.map((f) => f(ctx)); if (Object.keys(kw).length) a.push(Object.fromEntries(Object.entries(kw).map(([k, f]) => [k, f(ctx)]))); return a; };
    }
    function primary() {
      const tk = toks[p++];
      if (!tk) throw new TemplateError(`template error while templating string: unexpected end of template. String: {{ ${src} }}`);
      if (tk.t === "num" || tk.t === "str") return () => tk.v;
      if (tk.t === "kw" && /^(true|True)$/.test(tk.v)) return () => true;
      if (tk.t === "kw" && /^(false|False)$/.test(tk.v)) return () => false;
      if (tk.t === "kw" && /^(none|None)$/.test(tk.v)) return () => null;
      if (tk.t === "name") return (ctx) => ctx(tk.v);
      if (tk.v === "(") { const e = cond(); expect(")"); return e; }
      if (tk.v === "[") {
        const items = [];
        while (!peek("]")) { items.push(cond()); if (!take(",")) break; }
        expect("]");
        return (ctx) => items.map((f) => f(ctx));
      }
      if (tk.v === "{") {
        const pairs = [];
        while (!peek("}")) { const k = cond(); expect(":"); pairs.push([k, cond()]); if (!take(",")) break; }
        expect("}");
        return (ctx) => Object.fromEntries(pairs.map(([k, v]) => [toText(k(ctx)), v(ctx)]));
      }
      throw new TemplateError(`template error while templating string: unexpected '${tk.v}'. String: {{ ${src} }}`);
    }
    function postfix() {
      let e = primary();
      for (;;) {
        if (take(".")) { const k = name(); const o = e; e = (ctx) => getattr(o(ctx), k); }
        else if (take("[")) { const k = cond(); expect("]"); const o = e; e = (ctx) => getattr(o(ctx), k(ctx)); }
        else if (take("(")) {
          const a = args();
          const o = e;
          e = (ctx) => { const fn = real(o(ctx)); if (typeof fn !== "function") throw new TemplateError("'" + typeName(fn) + "' object is not callable"); return fn(...a(ctx)); };
        } else if (take("|")) {
          let f = name();
          while (take(".")) f += "." + name();
          const a = take("(") ? args() : () => [];
          const o = e;
          e = (ctx) => callFilter(f, [o(ctx), ...a(ctx)]);
        } else return e;
      }
    }
    function unary() {
      if (take("-")) { const e = unary(); return (ctx) => -real(e(ctx)); }
      return postfix();
    }
    function binary(next, ops, fn) {
      return () => {
        let e = next();
        for (;;) {
          const op = ops.find((o) => peek(o));
          if (!op) return e;
          p++;
          const l = e;
          const r = next();
          e = (ctx) => fn(op, real(l(ctx)), real(r(ctx)));
        }
      };
    }
    const mul = binary(unary, ["*", "/", "//", "%", "**"], (op, a, b) => ({ "*": () => (typeof a === "string" ? a.repeat(b) : a * b), "/": () => a / b, "//": () => Math.floor(a / b), "%": () => a % b, "**": () => a ** b }[op]()));
    const add = binary(mul, ["+", "-"], (op, a, b) => (op === "+" ? (Array.isArray(a) ? [...a, ...b] : a + b) : a - b));
    const cat = binary(add, ["~"], (op, a, b) => toText(a) + toText(b));
    function compare() {
      let e = cat();
      for (;;) {
        const op = ["==", "!=", "<=", ">=", "<", ">"].find((o) => peek(o)) || (peek("in") ? "in" : peek("not") && toks[p + 1] && toks[p + 1].v === "in" ? "not in" : null);
        if (op) {
          p += op === "not in" ? 2 : 1;
          const l = e;
          const r = cat();
          e = (ctx) => {
            const a = real(l(ctx));
            const b = real(r(ctx));
            if (op === "in" || op === "not in") {
              const has = Array.isArray(b) || typeof b === "string" ? b.includes(a) : isDict(b) ? a in b : false;
              return op === "in" ? has : !has;
            }
            const eq = JSON.stringify(a) === JSON.stringify(b);
            return { "==": eq, "!=": !eq, "<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b }[op];
          };
        } else if (take("is")) {
          const neg = take("not");
          const t = name();
          const a = take("(") ? args() : toks[p] && (toks[p].t === "str" || toks[p].t === "num") ? ((x) => () => [x])(toks[p++].v) : () => [];
          const l = e;
          e = (ctx) => callTest(t, l(ctx), a(ctx)) !== neg;
        } else return e;
      }
    }
    function not() { if (take("not")) { const e = not(); return (ctx) => !truthy(e(ctx)); } return compare(); }
    function and() { let e = not(); while (take("and")) { const l = e, r = not(); e = (ctx) => truthy(l(ctx)) && truthy(r(ctx)); } return e; }
    function or() { let e = and(); while (take("or")) { const l = e, r = and(); e = (ctx) => truthy(l(ctx)) || truthy(r(ctx)); } return e; }
    function cond() {
      const e = or();
      if (!take("if")) return e;
      const c = or();
      const other = take("else") ? cond() : () => "";
      return (ctx) => (truthy(c(ctx)) ? e(ctx) : other(ctx));
    }
    const expr = cond();
    if (p < toks.length) throw new TemplateError(`template error while templating string: expected token 'end of print statement', got '${toks[p].v}'. String: {{ ${src} }}`);
    return expr;
  }

  function evalExpr(src, lookup) { return compile(src)(lookup); }

  // Split a template into text, {{ }}, {% %} and {# #} parts, honouring "-" trims.
  function parts(text, trimBlocks) {
    const out = [];
    const re = /\{\{(-?)([\s\S]*?)(-?)\}\}|\{%(-?)([\s\S]*?)(-?)%\}|\{#[\s\S]*?#\}/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      out.push({ t: "text", v: text.slice(last, m.index) });
      if (m[2] !== undefined) out.push({ t: "expr", v: m[2].trim(), l: m[1], r: m[3] });
      else if (m[5] !== undefined) out.push({ t: "stmt", v: m[5].trim(), l: m[4], r: m[6] });
      else out.push({ t: "comment" });
      last = re.lastIndex;
    }
    out.push({ t: "text", v: text.slice(last) });
    for (let k = 0; k < out.length; k++) {
      const x = out[k];
      if (x.t === "text") continue;
      if (x.l && out[k - 1].t === "text") out[k - 1].v = out[k - 1].v.replace(/\s+$/, "");
      const after = out[k + 1];
      if (after && after.t === "text" && (x.r || (trimBlocks && x.t !== "expr"))) after.v = x.r ? after.v.replace(/^\s+/, "") : after.v.replace(/^\n/, "");
    }
    return out;
  }

  // Parse a template into a tree, so an untaken branch is never evaluated.
  function tree(text, trimBlocks) {
    const ps = parts(text, trimBlocks);
    let k = 0;
    function nodes(stop) {
      const out = [];
      while (k < ps.length) {
        const x = ps[k];
        if (x.t !== "stmt") { if (x.t !== "comment") out.push(x); k++; continue; }
        const kw = x.v.split(/\s+/)[0];
        if (stop.includes(kw)) return out;
        k++;
        if (kw === "if") {
          const node = { t: "if", branches: [[x.v.slice(2), nodes(["elif", "else", "endif"])]] };
          for (;;) {
            const y = ps[k++];
            const w = y.v.split(/\s+/)[0];
            if (w === "endif") break;
            node.branches.push([w === "else" ? "true" : y.v.slice(4), nodes(["elif", "else", "endif"])]);
          }
          out.push(node);
        } else if (kw === "for") {
          const m = /^for\s+(\w+)(?:\s*,\s*(\w+))?\s+in\s+([\s\S]+)$/.exec(x.v);
          if (!m) throw new TemplateError(`template error while templating string: expected 'in'. String: {% ${x.v} %}`);
          out.push({ t: "for", a: m[1], b: m[2], seq: m[3], body: nodes(["endfor"]) });
          k++;
        } else if (kw === "set") {
          const m = /^set\s+(\w+)\s*=\s*([\s\S]+)$/.exec(x.v);
          if (!m) throw new TemplateError(`template error while templating string: expected '='. String: {% ${x.v} %}`);
          out.push({ t: "set", name: m[1], v: m[2] });
        } else {
          throw new TemplateError(`template error while templating string: Encountered unknown tag '${kw}'.`);
        }
      }
      if (stop.length) throw new TemplateError(`template error while templating string: Unexpected end of template. Jinja was looking for the following tags: '${stop[stop.length - 1]}'. The innermost block that needs to be closed is '${stop.includes("endif") ? "if" : "for"}'.`);
      return out;
    }
    return nodes([]);
  }

  function render(text, lookup, opts = {}) {
    text = String(text);
    // A value that is one expression keeps its type: "{{ users }}" is the dict itself.
    const one = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(text);
    if (one && !one[1].includes("}}") && !one[1].includes("{{")) return real(evalExpr(one[1], lookup));
    if (!/\{\{|\{%|\{#/.test(text)) return text;
    const vars = {};
    const scoped = (name) => (name in vars ? vars[name] : lookup(name));
    const run = (list) => list.map((n) => {
      if (n.t === "text") return n.v;
      if (n.t === "expr") return toText(real(evalExpr(n.v, scoped)));
      if (n.t === "set") { vars[n.name] = real(evalExpr(n.v, scoped)); return ""; }
      if (n.t === "if") { const b = n.branches.find(([c]) => truthy(evalExpr(c, scoped))); return b ? run(b[1]) : ""; }
      let seq = real(evalExpr(n.seq, scoped));
      if (isDict(seq)) seq = n.b ? Object.entries(seq) : Object.keys(seq);
      const s = seq.map((item, idx) => {
        if (n.b) { vars[n.a] = item[0]; vars[n.b] = item[1]; } else vars[n.a] = item;
        vars.loop = { index: idx + 1, index0: idx, first: idx === 0, last: idx === seq.length - 1, length: seq.length };
        return run(n.body);
      }).join("");
      delete vars.loop;
      return s;
    }).join("");
    return run(tree(text, opts.trimBlocks));
  }

  // Template every string inside a value (task arguments, loop lists).
  function renderDeep(v, lookup) {
    if (typeof v === "string") return /\{\{|\{%/.test(v) ? render(v, lookup) : v;
    if (Array.isArray(v)) return v.map((x) => renderDeep(x, lookup));
    if (isDict(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderDeep(x, lookup)]));
    return v;
  }

  function toYaml(v, ind = 0) {
    const pad = " ".repeat(ind);
    const sc = (x) => (typeof x === "string" ? (/^[\w./-][\w ./:-]*$/.test(x) && !/: /.test(x) && typeof scalar(x) === "string" ? x : pyStr(x)) : x === null ? "null" : String(x));
    if (Array.isArray(v)) return v.length ? v.map((x) => pad + "- " + (typeof x === "object" && x ? toYaml(x, ind + 2).trimStart() : sc(x) + "\n")).join("") : pad + "[]\n";
    if (isDict(v)) return Object.keys(v).length ? Object.entries(v).map(([k, x]) => pad + k + ":" + (typeof x === "object" && x && (Array.isArray(x) ? x.length : Object.keys(x).length) ? "\n" + toYaml(x, ind + 2) : " " + (typeof x === "object" && x ? (Array.isArray(x) ? "[]" : "{}") : sc(x)) + "\n")).join("") : pad + "{}\n";
    return pad + sc(v) + "\n";
  }

  // --- Vault -------------------------------------------------------------------

  // Not AES: a reversible stand-in with the same file format, so the
  // playground can encrypt and decrypt without a crypto library.
  const VAULT_HEADER = "$ANSIBLE_VAULT;1.1;AES256";
  function hashHex(s) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    let out = "";
    for (let round = 0; round < 4; round++) {
      for (let k = 0; k < s.length; k++) { h1 = Math.imul(h1 ^ s.charCodeAt(k), 16777619) >>> 0; h2 = Math.imul(h2 + s.charCodeAt(k) + round, 2246822519) >>> 0; }
      out += ((h1 ^ h2) >>> 0).toString(16).padStart(8, "0") + h1.toString(16).padStart(8, "0");
    }
    return out;
  }
  const utf8 = (s) => unescape(encodeURIComponent(s));
  const fromUtf8 = (s) => decodeURIComponent(escape(s));
  const toHex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const fromHex = (h) => (h.match(/../g) || []).map((x) => String.fromCharCode(parseInt(x, 16))).join("");
  function stream(key, n) {
    let x = parseInt(hashHex(key).slice(0, 8), 16) || 1;
    const out = [];
    for (let k = 0; k < n; k++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out.push(x & 255); }
    return out;
  }
  function vaultEncrypt(plain, password) {
    const bytes = utf8(plain);
    const salt = hashHex(plain + password + bytes.length).slice(0, 64);
    const ks = stream(password + salt, bytes.length);
    const cipher = [...bytes].map((c, k) => String.fromCharCode(c.charCodeAt(0) ^ ks[k])).join("");
    const body = toHex(salt + "\n" + hashHex(password + plain).slice(0, 64) + "\n" + toHex(cipher));
    return VAULT_HEADER + "\n" + (body.match(/.{1,80}/g) || []).join("\n");
  }
  // Returns the plain text, or null when the password does not open it.
  function vaultDecrypt(text, password) {
    const lines = String(text).trim().split("\n");
    if (!lines[0].startsWith("$ANSIBLE_VAULT;")) return null;
    const [salt, mac, hex] = fromHex(lines.slice(1).join("").replace(/\s/g, "")).split("\n");
    if (!hex) return null;
    const cipher = fromHex(hex);
    const ks = stream(password + salt, cipher.length);
    let plain;
    try { plain = fromUtf8([...cipher].map((c, k) => String.fromCharCode(c.charCodeAt(0) ^ ks[k])).join("")); } catch { return null; }
    return hashHex(password + plain).slice(0, 64) === mac ? plain : null;
  }
  const isVaultText = (s) => String(s).trimStart().startsWith("$ANSIBLE_VAULT;");

  const b64 = (x) => (typeof btoa === "function" ? btoa(utf8(x)) : Buffer.from(x).toString("base64"));
  const unb64 = (x) => (typeof atob === "function" ? fromUtf8(atob(x)) : Buffer.from(x, "base64").toString());

  root.AQLang = {
    parseYaml, YamlError, POS, Vaulted, parseKv, whereText, QUOTE_HINT, parseIni, expandRange,
    Undef, TemplateError, TYPE, render, renderDeep, evalExpr, truthy, getattr, isDict, toText, pyRepr, pyJson, toYaml,
    vaultEncrypt, vaultDecrypt, isVaultText, VAULT_HEADER, hashHex, b64
  };
})(typeof window !== "undefined" ? window : globalThis);
