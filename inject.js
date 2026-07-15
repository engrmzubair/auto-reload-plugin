// Runs in the page's MAIN world at document_start, in every frame.
// We only READ responses the page already requested -- we never originate one.
//
// RECON MODE (deliberate, see below):
//   Upwork runs its feed inside a micro-frontend sandbox (srcdoc iframe). We
//   need to know WHICH frame issues mostRecentRecommendationsFeed before we dare
//   wrap anything in it -- patching blind already broke the feed once, because
//   native fetch throws "Illegal invocation" when a sandboxed caller's `this`
//   isn't a real window.
//
//   So: the top frame gets the real hook (proven safe there). Sub-frames get
//   PerformanceObserver ONLY -- it reads the browser's own network timeline and
//   wraps nothing, so it is incapable of failing a request. Once recon names the
//   frame, we hook exactly that one.

(() => {
  const EVENT = "UWR_FEED";
  const TAG = "__uwrPatched";
  const IS_TOP = window.top === window.self;

  function frameId() {
    if (IS_TOP) return "top";
    let tag = "";
    try {
      const fe = window.frameElement;
      if (fe) tag = fe.id || fe.name || fe.className || fe.tagName.toLowerCase();
    } catch (_) {
      tag = "cross-origin";
    }
    return `sub:${location.href.slice(0, 24)}${tag ? " " + tag.slice(0, 24) : ""}`;
  }

  const FRAME = frameId();

  function emit(name, detail) {
    if (!IS_TOP) {
      try {
        window.top.postMessage({ __uwr: name, detail }, "*");
        return;
      } catch (_) {}
    }
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  const report = (stage, detail) => emit("UWR_DEBUG", Object.assign({ stage, frame: FRAME }, detail));

  // ---------- recon: read-only, every frame ----------

  const seenAliases = new Set();
  let hookedHere = IS_TOP;
  // When (in performance-timeline terms) this frame got hooked. The observer
  // runs with buffered:true and replays entries from before we existed, so the
  // bypass check has to ignore anything that started earlier -- otherwise it
  // judges a page-load request against a hook installed afterwards and cries
  // BYPASSED while capture is working fine.
  let hookedAtPerf = IS_TOP ? 0 : Infinity;

  // Upwork's whole app lives in an about:blank iframe, and so does its feed
  // query -- but so might Forter's sandbox, and patching that one broke the feed
  // before. So a sub-frame earns its hook: only once we OBSERVE it issuing a
  // recommendations-feed call do we wrap fetch there. Self-targeting, so we
  // never touch a frame that isn't the job feed.
  const isFeedAlias = (alias) => /RecommendationsFeed/i.test(alias);

  function installObserver() {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.name || entry.name.indexOf("/api/graphql") === -1) continue;
          const alias = (entry.name.match(/alias=([^&]+)/) || [])[1] || "(none)";
          const wasHooked = hookedHere;

          if (!hookedHere && isFeedAlias(alias)) {
            hookedHere = true;
            hookedAtPerf = performance.now();
            installResponseHook();
            report("frame-hooked", { alias, why: "issues the feed query" });
          } else if (
            wasHooked &&
            isFeedAlias(alias) &&
            entry.startTime > hookedAtPerf &&
            captures === 0
          ) {
            // "Bypassed" means the hook has NEVER worked in this frame. Once
            // we've captured even once the hook is proven, and a later quiet call
            // just means an empty or errored response -- not worth alarming over.
            const at = Date.now();
            setTimeout(() => {
              if (captures === 0 && lastAt < at) report("hook-bypassed", { alias });
            }, 2000);
          }

          if (seenAliases.has(alias)) continue;
          seenAliases.add(alias);
          report("graphql-observed", { alias, hooked: wasHooked });
        }
      });
      po.observe({ type: "resource", buffered: true });
    } catch (_) {}
  }

  // ---------- capture: top frame only, for now ----------

  function extractResults(payload) {
    const data = payload && payload.data;
    if (!data || typeof data !== "object") return null;
    for (const key of Object.keys(data)) {
      const node = data[key];
      if (node && Array.isArray(node.results) && node.results.length) {
        return { feed: key, results: node.results };
      }
    }
    return null;
  }

  let lastSig = "";
  let lastAt = 0;
  let captures = 0;

  function publish(payload, via) {
    const found = extractResults(payload);
    if (!found) {
      const keys = Object.keys((payload && payload.data) || {});
      if (keys.length) report("graphql-seen-no-results", { via, keys });
      return;
    }
    const first = found.results[0] || {};
    const sig = `${found.feed}:${found.results.length}:${first.uid || first.id}`;
    if (sig === lastSig && Date.now() - lastAt < 1000) return;
    lastSig = sig;
    lastAt = Date.now();
    captures++;
    report("feed-captured", { via, feed: found.feed, count: found.results.length });
    emit(EVENT, { feed: found.feed, results: found.results, at: Date.now() });
  }

  const isGraphql = (url) => typeof url === "string" && url.includes("/api/graphql");

  // The hook that actually works here.
  //
  // Replacing window.fetch fails both ways: install it late and Upwork's bundle
  // never calls it (it snapshotted fetch at init -- the ofetch pattern), install
  // it at document_start and the app frame never boots at all.
  //
  // But whatever fetch reference the bundle holds, it still parses responses by
  // calling response.json() -- and that resolves through Response.prototype on
  // EVERY call. So a late patch here is still invoked, which lets us wait until
  // a frame proves it's the feed frame before touching it.
  //
  // It's also gentler: we attach to the promise the app already made and hand
  // back the very same promise. We consume nothing (json() yields a parsed
  // object, not a stream), so the app's own .then still receives its data.
  function installResponseHook() {
    const proto = Response.prototype;
    if (!proto || !proto.json || proto.json[TAG]) return false;

    const wrap = (name, parse) => {
      const original = proto[name];
      if (!original || original[TAG]) return;
      const patched = function (...args) {
        const promise = original.apply(this, args);
        try {
          const url = this && this.url;
          if (isGraphql(url)) {
            promise
              .then((value) => publish(parse(value), `Response.${name}`))
              .catch(() => {});
          }
        } catch (_) {}
        return promise;
      };
      patched[TAG] = true;
      try {
        proto[name] = patched;
      } catch (_) {}
    };

    wrap("json", (v) => v);
    // Some HTTP clients read text() and JSON.parse it themselves.
    wrap("text", (v) => {
      try {
        return JSON.parse(v);
      } catch (_) {
        return null;
      }
    });
    return true;
  }

  function installFetch() {
    const current = window.fetch;
    if (!current || current[TAG]) return false;
    const original = current;
    const patched = function (...args) {
      // Always invoke against the real window: native fetch throws "Illegal
      // invocation" if `this` is a sandbox proxy or undefined, which turns this
      // wrapper from a hook into a broken feed.
      const promise = original.apply(window, args);
      try {
        const input = args[0];
        const url = typeof input === "string" ? input : input && input.url;
        if (isGraphql(url)) {
          promise
            .then((res) => res.clone().json())
            .then((p) => publish(p, "fetch"))
            .catch(() => {});
        }
      } catch (_) {}
      return promise;
    };
    patched[TAG] = true;
    try {
      window.fetch = patched;
    } catch (_) {
      return false;
    }
    return true;
  }

  function installXhr() {
    const proto = XMLHttpRequest.prototype;
    if (proto.open[TAG]) return false;
    const originalOpen = proto.open;
    const originalSend = proto.send;

    const openPatched = function (method, url, ...rest) {
      this.__uwrUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };
    openPatched[TAG] = true;
    proto.open = openPatched;

    const sendPatched = function (...args) {
      if (isGraphql(this.__uwrUrl)) {
        this.addEventListener("load", () => {
          try {
            publish(JSON.parse(this.responseText), "xhr");
          } catch (_) {}
        });
      }
      return originalSend.apply(this, args);
    };
    sendPatched[TAG] = true;
    proto.send = sendPatched;
    return true;
  }

  // Nothing is patched at document_start. Doing so killed the app frame outright
  // -- it stopped issuing every one of its ~35 queries and the feed died. Only
  // the read-only observer runs up front; the Response hook is installed later,
  // and only in a frame that has proven it issues the feed query.
  //
  // The top frame is hooked immediately: it only serves ads and nav context, it
  // has never broken, and it costs nothing to watch.
  if (IS_TOP) {
    hookedHere = true;
    installFetch();
    installXhr();
    installResponseHook();
  }
  installObserver();

  setInterval(() => {
    if (!hookedHere) return;
    installResponseHook();
    if (IS_TOP) {
      installFetch();
      installXhr();
    }
  }, 2000);

  report("injected", { hooked: IS_TOP });
})();
