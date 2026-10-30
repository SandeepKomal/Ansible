// Search over the troubleshooting reference with pasted error text. Words of
// the query found in an entry's error count most, its title next, its other
// text least; host names and addresses are ignored. No DOM access.
"use strict";

(function (root) {
  const STOP = new Set("the and for was with that this from have not are but you all fatal failed msg changed false true unreachable error errors appears line column may file offending here task".split(" "));
  const words = (s) => [...new Set(String(s).toLowerCase().replace(/\b(web|db|lb|api|edge)-\d+\b|\b\d+(\.\d+){1,3}\b/g, " ").split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !STOP.has(w)))];
  const cache = new WeakMap();

  // Returns the indexes of the best entries, best first.
  function search(doctor, q, limit = 6) {
    if (!cache.has(doctor)) cache.set(doctor, doctor.map((d) => ({ error: d.error.toLowerCase(), title: d.title.toLowerCase(), body: [d.symptom, ...d.causes, ...d.confirm, ...d.fix].join(" ").toLowerCase() })));
    const hay = cache.get(doctor);
    const ws = words(q);
    if (!ws.length) return [];
    const flat = String(q).toLowerCase().replace(/\s+/g, " ").trim();
    return hay.map((x, i) => {
      let s = 0;
      for (const w of ws) s += x.error.includes(w) || x.title.includes(w) ? 3 : x.body.includes(w) ? 1 : 0;
      if (flat.length > 12 && (x.error.includes(flat) || flat.includes(x.title))) s += 20;
      return [s / Math.sqrt(ws.length), i];
    }).filter(([s]) => s >= 1).sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, i]) => i);
  }

  root.AQSearch = search;
})(typeof window !== "undefined" ? window : globalThis);
