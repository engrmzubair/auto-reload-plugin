// Listens for feed responses captured by inject.js, scores them, keeps a
// permanent deduplicated feed in chrome.storage, and rings on a match.

const STORE_JOBS = "uwr_jobs";
const STORE_RULES = "uwr_rules";
const STORE_SETTINGS = "uwr_settings";
const STORE_DISMISSED = "uwr_dismissed";
const MAX_JOBS = 400;
const MAX_DISMISSED = 3000;
// NEW means "posted recently enough that you can still be early" -- not "we
// happened to see it just now", which labelled 9-hour-old jobs NEW on first
// capture because everything is new to an empty store.
const FRESH_MS = 15 * 60 * 1000;

let jobs = [];
let dismissed = new Set();
let rules = {};
let settings = {
  sound: true,
  speak: true,
  ntfyTopic: "",
  reloadMs: 30000,
  reloadOn: false,
  maxAgeHours: 24,
  sortBy: "new",
};
let audioCtx = null;
let reloadTimer = null;

// ---------- storage ----------

function load() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORE_JOBS, STORE_RULES, STORE_SETTINGS, STORE_DISMISSED], (r) => {
      jobs = r[STORE_JOBS] || [];
      rules = r[STORE_RULES] || {};
      settings = Object.assign(settings, r[STORE_SETTINGS] || {});
      dismissed = new Set(r[STORE_DISMISSED] || []);
      prune();
      resolve();
    });
  });
}

// A job you can no longer win is not worth storing. Age out by POSTED time, not
// by when we saw it, so a backlog can't masquerade as a live feed.
function prune() {
  const maxAge = (settings.maxAgeHours || 24) * 3600 * 1000;
  const cutoff = Date.now() - maxAge;
  jobs = jobs
    .filter((j) => !dismissed.has(j.id))
    .filter((j) => (j.postedAt || j.firstSeenAt || 0) > cutoff)
    .slice(0, MAX_JOBS);
}

function saveJobs() {
  prune();
  chrome.storage.local.set({ [STORE_JOBS]: jobs });
}

function saveDismissed() {
  // Keep ids after the job itself ages out, so a dismissed job can't return.
  const keep = [...dismissed].slice(-MAX_DISMISSED);
  dismissed = new Set(keep);
  chrome.storage.local.set({ [STORE_DISMISSED]: keep });
}

function saveSettings() {
  chrome.storage.local.set({ [STORE_SETTINGS]: settings });
}

// The popup and this page each hold their own copy of settings. Without this,
// saving a topic in the popup left the page unaware of it -- and worse, the next
// thing that wrote settings from here (toggling Auto or sort) wrote back a stale
// object and silently wiped the topic you just saved.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORE_SETTINGS]) {
    settings = Object.assign(settings, changes[STORE_SETTINGS].newValue || {});
    prune();
    render();
  }
  if (changes[STORE_RULES]) rules = changes[STORE_RULES].newValue || {};
});

// ---------- audio ----------

// Chrome blocks audio until the user has interacted with the page, and a
// reload resets that. We prime the context on the first click anywhere.
function primeAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}
document.addEventListener("click", primeAudio, { capture: true });
document.addEventListener("keydown", primeAudio, { capture: true });

function beep(freq, startAt, dur) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.3, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.05);
}

function ring(rounds = 4) {
  if (!settings.sound) return;
  primeAudio();
  if (!audioCtx || audioCtx.state !== "running") return;
  for (let i = 0; i < rounds; i++) {
    const t = audioCtx.currentTime + i * 0.55;
    beep(880, t, 0.16);
    beep(1320, t + 0.18, 0.16);
  }
}

function speak(job) {
  if (!settings.speak || !window.speechSynthesis) return;
  const rate = job.hourlyStated
    ? `${Math.round(job.hourlyMin)} to ${Math.round(job.hourlyMax)} dollars an hour`
    : job.fixedBudget
    ? `${Math.round(job.fixedBudget)} dollars fixed`
    : "rate not stated";
  const u = new SpeechSynthesisUtterance(
    `New job. ${job.title}. ${rate}. Client spent ${Math.round(job.spent)} dollars.`
  );
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}

// ---------- ingest ----------

// inject.js narrates what it sees so a silent panel is diagnosable instead of
// looking like "no jobs matched".
let status = { text: "waiting for feed…", kind: "" };

function setStatus(text, kind) {
  status = { text, kind: kind || "" };
  const el = panel.querySelector("#uwr-status");
  if (el) {
    el.textContent = text;
    el.className = status.kind;
  }
}

// Upwork runs its micro-frontends inside srcdoc iframes, so the feed query
// executes in a sandboxed realm with its own window.fetch. inject.js hooks that
// realm too and forwards captures up here by postMessage.
//
// A srcdoc frame normally inherits its parent's origin, but a sandboxed one
// reports "null". We accept that -- worst case a rogue frame puts a bogus job in
// the panel, which is cosmetic -- but nothing here is ever executed or trusted
// beyond scoring.
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || typeof m !== "object" || typeof m.__uwr !== "string") return;
  if (e.origin !== "https://www.upwork.com" && e.origin !== "null") return;
  window.dispatchEvent(new CustomEvent(m.__uwr, { detail: m.detail }));
});

// Recon: which frame actually issues each graphql alias, and is it one we hook?
// PerformanceObserver reports this without wrapping anything, so it cannot break
// a request the way the blind fetch patch did.
const recon = new Map();

// Interesting aliases sort to the top; the marketing chatter (smf.retrieve.*)
// is noise we still show, because "the feed alias never appeared at all" is
// itself a finding.
window.addEventListener("UWR_DEBUG", (e) => {
  const d = e.detail || {};
  if (d.stage === "graphql-observed") {
    // Kept in memory for the Copy diagnostic and the console; it's no longer
    // worth permanent panel space now that capture works.
    recon.set(d.alias, { frame: d.frame, hooked: d.hooked });
    console.debug("[radar] recon", d.alias, "frame=", d.frame, "hooked=", d.hooked);
  } else if (d.stage === "frame-hooked") {
    setStatus(`hooked the feed frame (${d.alias}) — hit ↻ again to capture`, "ok");
    console.info("[radar] hooked feed frame:", d.frame, d.alias);
  } else if (d.stage === "hook-bypassed") {
    // The decisive symptom: hooked, a feed call fired, nothing came back.
    setStatus(`BYPASSED: ${d.alias} fired through a hooked frame but never reached us`, "err");
    console.warn("[radar] hook bypassed — app holds its own fetch reference:", d);
  } else if (d.stage === "feed-captured") setStatus(`captured ${d.count} jobs via ${d.via} (${d.frame})`, "ok");
  else if (d.stage === "graphql-seen-no-results") setStatus(`graphql in ${d.frame}: ${(d.keys || []).join(",")}`);
  else if (d.stage === "injected" && recon.size === 0) setStatus(`live in ${d.frame} — hit ↻ Refresh`);
});

window.addEventListener("UWR_FEED", (e) => {
  const results = e.detail && e.detail.results;
  if (!Array.isArray(results)) return;

  const known = new Set(jobs.map((j) => j.id));
  const fresh = [];

  for (const raw of results) {
    const scored = window.UWR.evaluate(raw, rules);
    if (!scored.id || known.has(scored.id) || dismissed.has(scored.id)) continue;
    // firstSeenAt is our own clock. It is more precise than the "24 minutes
    // ago" the page renders, and it survives reloads.
    scored.firstSeenAt = Date.now();
    jobs.push(scored);
    known.add(scored.id);
    if (scored.verdict !== window.UWR.VERDICT.HIDE) fresh.push(scored);
  }

  const feedName = (e.detail && e.detail.feed) || "feed";
  setStatus(
    `${feedName}: ${results.length} seen, ${fresh.length} new · ${new Date().toLocaleTimeString()}`,
    "ok"
  );

  if (!fresh.length) {
    render();
    return;
  }

  saveJobs();

  // Only ring for jobs you could still win. Without this, the first capture of
  // the day dumps hours of backlog and rings a dozen times for jobs that already
  // have 50+ proposals -- which is how you learn to ignore the alarm.
  const ringMaxAge = (settings.ringMaxAgeMin || 60) * 60 * 1000;
  const rings = fresh.filter(
    (j) =>
      j.verdict === window.UWR.VERDICT.RING && j.postedAt && Date.now() - j.postedAt < ringMaxAge
  );
  if (rings.length) {
    ring();
    speak(rings[0]);
    chrome.runtime.sendMessage({ type: "UWR_ALERT", jobs: rings, ntfyTopic: settings.ntfyTopic });
  }
  render();
});

// ---------- panel ----------

const panel = document.createElement("div");
panel.id = "uwr-panel";
const style = document.createElement("style");
style.textContent = `
#uwr-panel{position:fixed;top:0;right:0;width:380px;height:100vh;background:#14181d;color:#e8eaed;
  font:13px/1.45 system-ui,sans-serif;z-index:2147483000;display:flex;flex-direction:column;
  box-shadow:-2px 0 16px rgba(0,0,0,.4);transition:transform .2s}
#uwr-panel.collapsed{transform:translateX(368px)}
#uwr-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0e1116;border-bottom:1px solid #262c34}
#uwr-head b{font-size:13px;letter-spacing:.02em}
#uwr-grip{cursor:pointer;background:#262c34;border:0;color:#e8eaed;border-radius:4px;padding:4px 7px;font-size:14px}
#uwr-count{margin-left:auto;font-size:11px;color:#8b949e}
#uwr-list{flex:1;overflow-y:auto;padding:8px}
.uwr-card{position:relative;background:#1b2027;border:1px solid #262c34;border-left-width:3px;border-radius:6px;padding:9px 10px;margin-bottom:7px}
.uwr-x{position:absolute;top:5px;right:5px;width:18px;height:18px;line-height:1;border:0;border-radius:3px;
  background:transparent;color:#4d5560;font-size:11px;cursor:pointer;padding:0}
.uwr-card:hover .uwr-x{background:#262c34;color:#f85149}
.uwr-card.RING{border-left-color:#f85149;background:#22181a}
.uwr-card.FEED{border-left-color:#3fb950}
.uwr-card.HIDE{border-left-color:#30363d;opacity:.5}
.uwr-title{font-weight:600;font-size:12.5px;color:#e8eaed;text-decoration:none;display:block;margin-bottom:5px}
.uwr-title:hover{color:#58a6ff;text-decoration:underline}
.uwr-row{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px}
.uwr-chip{background:#262c34;border-radius:3px;padding:1px 5px;font-size:10.5px;color:#c9d1d9;white-space:nowrap}
.uwr-chip.good{background:#12331d;color:#56d364}
.uwr-chip.bad{background:#3a1416;color:#f85149}
.uwr-chip.warn{background:#39270a;color:#e3b341}
.uwr-new{background:#1f6feb;color:#fff;font-weight:700}
.uwr-meta{font-size:10.5px;color:#7d8590;display:flex;gap:8px;flex-wrap:wrap}
.uwr-empty{color:#7d8590;text-align:center;padding:28px 12px;font-size:12px}
#uwr-status{padding:4px 12px;background:#0e1116;border-top:1px solid #262c34;font-size:10px;color:#6e7681;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#uwr-status.ok{color:#3fb950}
#uwr-status.err{color:#f85149}
#uwr-foot{padding:7px 12px;background:#0e1116;display:flex;gap:6px;align-items:center}
#uwr-foot button{background:#262c34;border:0;color:#c9d1d9;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer}
#uwr-foot button:hover{background:#30363d}
#uwr-foot button.on{background:#1f6feb;color:#fff}
`;
document.documentElement.appendChild(style);

function chip(text, kind) {
  return `<span class="uwr-chip ${kind || ""}">${text}</span>`;
}

function cardHtml(j) {
  const M = window.UWR.money;
  const perHire =
    j.perHire === null
      ? chip("$?/hire", "warn")
      : chip(`${M(j.perHire)}/hire`, j.perHire >= 100 ? "good" : "bad");
  const rate = j.hourlyStated
    ? chip(`$${Math.round(j.hourlyMin)}-${Math.round(j.hourlyMax)}/hr`, j.hourlyMin >= 15 ? "good" : "bad")
    : j.fixedBudget !== null
    ? chip(`${M(j.fixedBudget)} fixed`, j.fixedBudget >= 1000 ? "good" : "bad")
    : chip("rate unstated", "warn");
  const spend = chip(`${M(j.spent)} spent`, j.spent >= 2000 ? "good" : "bad");
  const rating =
    j.rating === null ? chip("no rating", "warn") : chip(`${j.rating.toFixed(2)} (${j.reviews})`, j.reviews >= 3 && j.rating >= 4.5 ? "good" : "warn");
  const url = j.ciphertext ? `https://www.upwork.com/nx/find-work/most-recent/details/${j.ciphertext}` : "#";
  const fresh = j.postedAt && Date.now() - j.postedAt < FRESH_MS;

  return `<div class="uwr-card ${j.verdict}">
    <button class="uwr-x" data-id="${escapeHtml(j.id)}" title="Not interested — hide it and never ring for it again">✕</button>
    <a class="uwr-title" href="${url}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a>
    <div class="uwr-row">
      ${fresh ? chip("NEW", "uwr-new") : ""}
      ${perHire}${rate}${spend}${rating}
    </div>
    <div class="uwr-meta">
      <span>⏱ ${window.UWR.age(j.postedAt)} old</span>
      <span>👥 ${j.proposalsTier}</span>
      <span>📍 ${escapeHtml(j.country)}</span>
      <span>#${j.score}</span>
    </div>
    ${
      j.kills.length || j.flags.length
        ? `<div class="uwr-row" style="margin-top:5px">${j.kills
            .map((k) => chip("✕ " + escapeHtml(k), "bad"))
            .join("")}${j.flags.map((f) => chip("⚠ " + escapeHtml(f), "warn")).join("")}</div>`
        : ""
    }
  </div>`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

let showHidden = false;

function dismiss(id) {
  if (!id) return;
  dismissed.add(id);
  jobs = jobs.filter((j) => j.id !== id);
  saveDismissed();
  saveJobs();
  render();
}

function render() {
  const list = panel.querySelector("#uwr-list");
  const count = panel.querySelector("#uwr-count");
  if (!list) return;
  const kept = jobs.filter((j) => j.verdict !== window.UWR.VERDICT.HIDE);
  const rings = kept.filter((j) => j.verdict === window.UWR.VERDICT.RING).length;
  const hidden = jobs.length - kept.length;
  count.textContent = `${rings} ring · ${kept.length} kept · ${hidden} filtered`;

  const shown = (showHidden ? jobs.slice() : kept.slice()).sort((a, b) =>
    settings.sortBy === "score" ? b.score - a.score : (b.postedAt || 0) - (a.postedAt || 0)
  );

  list.innerHTML = shown.length
    ? shown.map(cardHtml).join("")
    : `<div class="uwr-empty">${
        jobs.length
          ? `All ${jobs.length} jobs were filtered out.<br>Hit “Filtered” to see why.`
          : "Nothing yet.<br>Hit ↻ Refresh and matching jobs collect here permanently."
      }</div>`;
}

panel.innerHTML = `
  <div id="uwr-head">
    <button id="uwr-grip" title="Collapse">❯</button>
    <b>Job Radar</b>
    <span id="uwr-count"></span>
  </div>
  <div id="uwr-list"></div>
  <div id="uwr-status">waiting for feed…</div>
  <div id="uwr-foot">
    <button id="uwr-now" title="Fetch the feed now">↻ Refresh</button>
    <button id="uwr-reload">▶ Auto</button>
    <button id="uwr-sort" title="Toggle ordering">Newest</button>
    <button id="uwr-filtered" title="Show what the rules killed, and why">Filtered</button>
    <button id="uwr-copy" title="Copy the full diagnostic to the clipboard">⧉ Copy</button>
    <button id="uwr-test">🔔 Test</button>
    <button id="uwr-clear">Clear</button>
  </div>`;

function mount() {
  document.body.appendChild(panel);

  panel.querySelector("#uwr-grip").onclick = () => {
    panel.classList.toggle("collapsed");
    panel.querySelector("#uwr-grip").textContent = panel.classList.contains("collapsed") ? "❮" : "❯";
  };

  panel.querySelector("#uwr-now").onclick = () => refreshFeed();

  // The panel crops long frame strings, which is exactly the detail that matters
  // when diagnosing. Hand over the whole thing as text instead.
  const copyBtn = panel.querySelector("#uwr-copy");
  copyBtn.onclick = async () => {
    const rows = [...recon.entries()].map(
      ([alias, i]) => `${i.hooked ? "HOOKED" : "blind "}  ${alias}  <- ${i.frame}`
    );
    const text = [
      `Job Radar diagnostic — ${new Date().toISOString()}`,
      `url: ${location.href}`,
      `panel: ${panel.querySelector("#uwr-count").textContent}`,
      `status: ${status.text}`,
      `jobs stored: ${jobs.length}`,
      "",
      `recon (${rows.length} aliases):`,
      ...rows,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "✓ Copied";
    } catch (_) {
      copyBtn.textContent = "see console";
      console.log(text);
    }
    setTimeout(() => (copyBtn.textContent = "⧉ Copy"), 1500);
  };

  const reloadBtn = panel.querySelector("#uwr-reload");
  function paintReload() {
    reloadBtn.textContent = settings.reloadOn ? "⏹ Auto" : "▶ Auto";
    reloadBtn.classList.toggle("on", !!settings.reloadOn);
  }
  reloadBtn.onclick = () => {
    settings.reloadOn = !settings.reloadOn;
    saveSettings();
    paintReload();
    if (settings.reloadOn) refreshFeed(); // don't make them wait out the first tick
    startReload();
  };
  paintReload();

  // Cards are re-rendered wholesale, so delegate rather than rebind per card.
  panel.querySelector("#uwr-list").addEventListener("click", (e) => {
    const x = e.target.closest(".uwr-x");
    if (!x) return;
    e.preventDefault();
    dismiss(x.dataset.id);
  });

  const sortBtn = panel.querySelector("#uwr-sort");
  function paintSort() {
    sortBtn.textContent = settings.sortBy === "score" ? "Best" : "Newest";
  }
  sortBtn.onclick = () => {
    settings.sortBy = settings.sortBy === "score" ? "new" : "score";
    saveSettings();
    paintSort();
    render();
  };
  paintSort();

  const filteredBtn = panel.querySelector("#uwr-filtered");
  filteredBtn.onclick = () => {
    showHidden = !showHidden;
    filteredBtn.classList.toggle("on", showHidden);
    render();
  };

  panel.querySelector("#uwr-test").onclick = () => {
    primeAudio();
    const demo = {
      id: "test",
      ciphertext: "",
      title: "Test alert — AI Voice Receptionist (Sophiie)",
      hourlyStated: true,
      hourlyMin: 25,
      hourlyMax: 45,
      fixedBudget: null,
      spent: 55466,
      perHire: 305,
      proposalsTier: "5 to 10",
    };
    ring(2);
    speak(demo);
    // Exercise the whole alert path -- desktop notification and phone push --
    // so a bad ntfy topic surfaces now rather than on the job you miss.
    setStatus("sending test alert…");
    chrome.runtime.sendMessage(
      { type: "UWR_ALERT", jobs: [demo], ntfyTopic: settings.ntfyTopic },
      (res) => {
        if (chrome.runtime.lastError) return setStatus("test failed: no background worker", "err");
        if (!settings.ntfyTopic) return setStatus("rang OK — no ntfy topic set, so no phone push");
        if (res && res.ok) setStatus(`test sent to ntfy.sh/${settings.ntfyTopic} — check your phone`, "ok");
        else setStatus(`phone push failed: ${(res && res.error) || "unknown"}`, "err");
      }
    );
  };

  panel.querySelector("#uwr-clear").onclick = () => {
    jobs = [];
    saveJobs();
    render();
  };

  render();
  startReload();

  // The feed is not inlined and no query fires on a hard load, so the panel
  // would sit empty until the first auto tick. Pull it once, after the SPA has
  // had time to wire up its router.
  setTimeout(refreshFeed, 2500);
}

// A full reload is the one thing that CANNOT work here: Upwork renders the feed
// server-side on a hard load and never calls GraphQL, so there is no response to
// intercept. Clicking a tab is a client-side route change, which does fire the
// query. Bouncing to the sibling tab and back also nets us both feeds, and never
// throws away scroll position.
function refreshFeed() {
  const recent = document.querySelector('[data-test="tab-most-recent"]');
  const best = document.querySelector('[data-test="tab-best-matches"]');
  if (!recent || !best) {
    setStatus("feed tabs not found — are you on Find Work?", "err");
    return;
  }
  // Clicking the tab you're already on is a no-op, so bounce to the sibling and
  // back. Both hops fire a query, which means we capture both feeds.
  const onBest = location.pathname.includes("best-matches");
  const here = onBest ? best : recent;
  const away = onBest ? recent : best;
  setStatus("refreshing…");
  away.click();
  setTimeout(() => here.click(), 2000);
}

function startReload() {
  clearTimeout(reloadTimer);
  if (!settings.reloadOn) return;
  const jitter = settings.reloadMs * (0.85 + Math.random() * 0.3);
  reloadTimer = setTimeout(() => {
    refreshFeed();
    startReload();
  }, jitter);
}

// Age chips go stale on a page that sits open.
setInterval(render, 30000);

load().then(() => {
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
});
