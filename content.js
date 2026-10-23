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
  reloadOn: false,
  // Auto-refresh only runs inside these windows, in Pakistan time.
  schedule: "14:00-17:00, 20:00-00:00",
  minGapMin: 3,
  maxGapMin: 8,
  dailyCap: 80,
  maxAgeHours: 24,
  sortBy: "new",
};
let audioCtx = null;
let reloadTimer = null;

// Auto-refresh bookkeeping, persisted so a page reload can't reset the day's
// count or cut a break short.
const STORE_SESSION = "uwr_session";
let session = { day: "", checks: 0, activeSince: 0, sessionMs: 0, breakUntil: 0 };

// ---------- storage ----------

function load() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORE_JOBS, STORE_RULES, STORE_SETTINGS, STORE_DISMISSED, STORE_SESSION], (r) => {
      jobs = r[STORE_JOBS] || [];
      rules = r[STORE_RULES] || {};
      settings = Object.assign(settings, r[STORE_SETTINGS] || {});
      dismissed = new Set(r[STORE_DISMISSED] || []);
      session = Object.assign(session, r[STORE_SESSION] || {});
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

function saveSession() {
  chrome.storage.local.set({ [STORE_SESSION]: session });
}

// The popup and this page each hold their own copy of settings. Without this,
// saving a topic in the popup left the page unaware of it -- and worse, the next
// thing that wrote settings from here (toggling Auto or sort) wrote back a stale
// object and silently wiped the topic you just saved.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORE_SETTINGS]) {
    const before = SCHEDULE_KEYS.map((k) => settings[k]).join("|");
    settings = Object.assign(settings, changes[STORE_SETTINGS].newValue || {});
    prune();
    render();
    // New hours or gaps from the popup take effect now, not after a reload. Only
    // on those keys: sorting or collapsing also writes settings, and must not
    // re-roll the countdown.
    if (SCHEDULE_KEYS.map((k) => settings[k]).join("|") !== before) startReload();
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
  const spent =
    job.spent === null || job.spent === undefined ? "" : ` Client spent ${Math.round(job.spent)} dollars.`;
  const u = new SpeechSynthesisUtterance(`New job. ${job.title}. ${rate}.${spent}`);
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
    setStatus(`hook bypassed — ${d.alias} never reached us`, "err");
    console.warn("[radar] hook bypassed — app holds its own fetch reference:", d);
  }
  // Everything else (every alias Upwork fires, every non-feed response) is
  // console-only. The status line is for things you'd act on, not a log tail.
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

  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  setStatus(`${results.length} seen · ${fresh.length} new · ${time} · ${session.checks} checks today`, "ok");

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

// Emoji render at different sizes in different fonts and can't be aligned or
// recoloured. Stroke icons share one grid, inherit currentColor, and stay put.
const svg = (body, fill) =>
  `<svg viewBox="0 0 24 24" fill="${fill ? "currentColor" : "none"}" stroke="${
    fill ? "none" : "currentColor"
  }" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  refresh: svg(
    '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'
  ),
  play: svg('<polygon points="6 3 20 12 6 21 6 3"/>', true),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>', true),
  clock: svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>'),
  star: svg('<polygon points="12 2.5 14.9 8.4 21.4 9.3 16.7 13.9 17.8 20.4 12 17.3 6.2 20.4 7.3 13.9 2.6 9.3 9.1 8.4 12 2.5"/>', true),
  eye: svg('<path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  bell: svg('<path d="M18 8.5A6 6 0 0 0 6 8.5c0 7-3 8.5-3 8.5h18s-3-1.5-3-8.5"/><path d="M13.7 20.5a2 2 0 0 1-3.4 0"/>'),
  trash: svg('<polyline points="3 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  check: svg('<polyline points="20 6 9 17 4 12"/>'),
  left: svg('<polyline points="15 18 9 12 15 6"/>'),
  right: svg('<polyline points="9 18 15 12 9 6"/>'),
};

const panel = document.createElement("div");
panel.id = "uwr-panel";
const style = document.createElement("style");
style.textContent = `
#uwr-panel{position:fixed;top:0;right:0;width:380px;height:100vh;background:#14181d;color:#e8eaed;
  font:13px/1.45 system-ui,sans-serif;z-index:2147483000;display:flex;flex-direction:column;
  box-shadow:-2px 0 16px rgba(0,0,0,.4);overflow:hidden;transition:width .18s ease}
/* Collapse to a rail wide enough to hold a real button. The old version slid the
   panel off-screen and left a 12px sliver -- narrower than the grip itself, so
   once collapsed there was no way back. */
#uwr-panel.collapsed{width:40px}
#uwr-panel.collapsed #uwr-head b,#uwr-panel.collapsed #uwr-count,#uwr-panel.collapsed #uwr-list,
#uwr-panel.collapsed #uwr-status,#uwr-panel.collapsed #uwr-foot,#uwr-panel.collapsed #uwr-tick{display:none}
#uwr-panel.collapsed #uwr-mini{display:flex}
#uwr-panel.collapsed #uwr-head{padding:10px 8px;justify-content:center;border-bottom:1px solid #262c34}

#uwr-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0e1116;border-bottom:1px solid #262c34;flex:none}
#uwr-head b{font-size:13px;letter-spacing:.02em;white-space:nowrap}
#uwr-grip{cursor:pointer;background:transparent;border:0;color:#8b949e;border-radius:5px;
  width:24px;height:24px;flex:none;display:flex;align-items:center;justify-content:center;padding:0}
#uwr-grip:hover{background:#262c34;color:#e8eaed}
#uwr-grip svg{width:15px;height:15px}
/* A chip, not a whisper. Tabular figures so the width never jitters. */
#uwr-tick{display:inline-flex;align-items:center;gap:5px;padding:3px 8px 3px 6px;border-radius:999px;
  font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;
  letter-spacing:-.02em;background:rgba(56,139,253,.15);border:1px solid rgba(56,139,253,.35);
  color:#79c0ff;transition:background .2s,border-color .2s,color .2s}
#uwr-tick:empty{display:none}
#uwr-tick::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;
  flex:none;animation:uwr-breathe 2s ease-in-out infinite}
/* Green as it comes due, so you can read "about to fetch" without reading digits. */
#uwr-tick.soon{background:rgba(63,185,80,.18);border-color:rgba(63,185,80,.4);color:#56d364}
/* Amber on a break, grey off-hours or capped: on, but deliberately not checking. */
#uwr-tick.rest,#uwr-mtick.rest{background:rgba(210,153,34,.15);border-color:rgba(210,153,34,.4);color:#e3b341}
#uwr-tick.idle,#uwr-mtick.idle{background:#1b2027;border-color:#30363d;color:#8b949e}
#uwr-tick.idle::before{animation:none}
@keyframes uwr-breathe{0%,100%{opacity:1}50%{opacity:.25}}
#uwr-count{margin-left:auto;font-size:11px;color:#8b949e;white-space:nowrap}

/* Collapsed rail. The one question it answers is "is there anything worth
   opening this for?" -- so RING is the hero and everything else recedes. */
#uwr-mini{display:none;flex-direction:column;align-items:center;flex:1;padding:12px 5px}
#uwr-mstats{display:flex;flex-direction:column;align-items:stretch;gap:6px;width:100%}

/* Each stat is a real block with its own surface, so the eye can separate them
   at a glance instead of parsing three floating numbers. */
.uwr-mstat{display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 0 7px;
  background:#1b2027;border:1px solid #262c34;border-radius:7px}
.uwr-mstat b{font-weight:800;line-height:1;font-variant-numeric:tabular-nums;
  display:flex;align-items:center;justify-content:center;border-radius:7px;color:#e8eaed}
.uwr-mstat em{font-size:8px;font-style:normal;font-weight:700;letter-spacing:.07em;color:#8b949e}

/* Colour means something only when the number isn't zero -- a red 0 is a lie. */
.uwr-mstat.zero b{color:#59606a}
.uwr-mstat.zero em{color:#59606a}

/* RING is the only reason this rail exists, so it gets the room. */
.uwr-mstat.ring b{font-size:22px;min-width:26px;height:26px;color:#ff7b72}
.uwr-mstat.filt{background:transparent;border-color:transparent;padding-top:4px}
.uwr-mstat.filt b{font-size:13px;height:16px;color:#8b949e}

/* Something is actually ringing: make it impossible to miss from the corner of
   your eye, since that is the entire reason the rail exists. */
@keyframes uwr-glow{
  0%,100%{box-shadow:0 0 0 0 rgba(248,81,73,.55)}
  50%{box-shadow:0 0 0 6px rgba(248,81,73,0)}
}
.uwr-mstat.ring.hot{background:rgba(248,81,73,.16);border-color:rgba(248,81,73,.45)}
.uwr-mstat.ring.hot b{background:#f85149;color:#fff;animation:uwr-glow 2.2s ease-out infinite}
.uwr-mstat.ring.hot em{color:#ff7b72}

.uwr-mdiv{display:none}

#uwr-mtick{margin-top:auto;font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  font-variant-numeric:tabular-nums;letter-spacing:-.04em;color:#79c0ff;
  background:rgba(56,139,253,.15);border:1px solid rgba(56,139,253,.35);
  border-radius:6px;padding:5px 4px;transition:background .2s,border-color .2s,color .2s}
#uwr-mtick:empty{display:none}
#uwr-mtick.soon{background:rgba(63,185,80,.18);border-color:rgba(63,185,80,.4);color:#56d364}
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
#uwr-foot{padding:8px 10px;background:#0e1116;display:flex;gap:3px;align-items:center;flex:none}
.uwr-sep{width:1px;height:18px;background:#262c34;margin:0 6px;flex:none}
#uwr-foot button{position:relative;width:34px;height:34px;flex:none;background:transparent;border:0;
  color:#8b949e;border-radius:6px;cursor:pointer;padding:0;
  display:flex;align-items:center;justify-content:center;transition:background .1s,color .1s}
#uwr-foot button svg{width:17px;height:17px;display:block}
#uwr-foot button:hover{background:#262c34;color:#e8eaed}
#uwr-foot button.on{background:#1f6feb;color:#fff}
/* Label on hover instead of permanently: the icons carry the meaning, the words
   are only needed the first few times. */
#uwr-foot button::after{content:attr(data-label);position:absolute;bottom:calc(100% + 7px);left:50%;
  transform:translateX(-50%);background:#0b0e12;color:#e8eaed;border:1px solid #30363d;border-radius:4px;
  padding:3px 7px;font-size:10px;font-weight:500;white-space:nowrap;opacity:0;pointer-events:none;
  transition:opacity .12s;z-index:2}
#uwr-foot button:hover::after{opacity:1}
#uwr-foot #uwr-clear:hover{background:#3a1416;color:#f85149}
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
  const spend = j.spendHidden
    ? chip("spend hidden", "warn")
    : chip(`${M(j.spent)} spent`, j.spent >= 2000 ? "good" : "bad");
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
      <span>👥 ${typeof j.applicants === "number" ? `${j.applicants} applied` : j.proposalsTier}</span>
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
  // "kept" used to sit here too, but it CONTAINS the rings -- so "12 ring · 14
  // kept" read like 26 jobs when it meant 14. Two overlapping counts side by
  // side is a bug, not a stat. RING is the signal; FILT proves the rules are
  // working. Quiet-but-kept jobs are still in the list below.
  count.textContent = `${rings} ring · ${hidden} filtered`;

  const mstats = panel.querySelector("#uwr-mstats");
  if (mstats) {
    mstats.innerHTML =
      `<div class="uwr-mstat ring${rings ? " hot" : " zero"}"><b>${rings}</b><em>RING</em></div>` +
      `<div class="uwr-mstat filt${hidden ? "" : " zero"}"><b>${hidden}</b><em>FILT</em></div>`;
  }

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
    <button id="uwr-grip">${ICON.right}</button>
    <b>Job Radar</b>
    <span id="uwr-tick"></span>
    <span id="uwr-count"></span>
  </div>
  <div id="uwr-mini">
    <div id="uwr-mstats"></div>
    <div id="uwr-mtick"></div>
  </div>
  <div id="uwr-list"></div>
  <div id="uwr-status">waiting for feed…</div>
  <div id="uwr-foot">
    <button id="uwr-now" data-label="Refresh now">${ICON.refresh}</button>
    <button id="uwr-reload" data-label="Auto-refresh off">${ICON.play}</button>
    <i class="uwr-sep"></i>
    <button id="uwr-sort" data-label="Newest first">${ICON.clock}</button>
    <button id="uwr-filtered" data-label="Show filtered">${ICON.eye}</button>
    <i class="uwr-sep"></i>
    <button id="uwr-test" data-label="Test alert">${ICON.bell}</button>
    <button id="uwr-clear" data-label="Clear all">${ICON.trash}</button>
  </div>`;

function mount() {
  document.body.appendChild(panel);

  const grip = panel.querySelector("#uwr-grip");
  grip.onclick = () => {
    const collapsed = panel.classList.toggle("collapsed");
    grip.innerHTML = collapsed ? ICON.left : ICON.right;
    settings.collapsed = collapsed;
    saveSettings();
  };
  if (settings.collapsed) {
    panel.classList.add("collapsed");
    grip.innerHTML = ICON.left;
  }

  panel.querySelector("#uwr-now").onclick = () => refreshFeed();

  // Diagnostics moved to the console (see the UWR_DEBUG handler) now that
  // capture works. window.__uwrDiag() dumps the same report if this ever breaks
  // again -- Upwork will change their frontend eventually.
  window.__uwrDiag = () => {
    const rows = [...recon.entries()].map(
      ([alias, i]) => `${i.hooked ? "HOOKED" : "blind "}  ${alias}  <- ${i.frame}`
    );
    console.log(
      [
        `Job Radar — ${new Date().toISOString()}`,
        `status: ${status.text}`,
        `jobs stored: ${jobs.length} · dismissed: ${dismissed.size}`,
        "",
        `recon (${rows.length} aliases):`,
        ...rows,
      ].join("\n")
    );
  };

  const reloadBtn = panel.querySelector("#uwr-reload");
  function paintReload() {
    reloadBtn.innerHTML = settings.reloadOn ? ICON.pause : ICON.play;
    // Show the range, not a number -- there is no single interval any more.
    const [lo, hi] = gapRangeMs().map((ms) => Math.round(ms / 60000));
    reloadBtn.dataset.label = settings.reloadOn
      ? `Auto-refresh on (every ${lo}–${hi} min, active hours only)`
      : "Auto-refresh off";
    reloadBtn.classList.toggle("on", !!settings.reloadOn);
  }
  reloadBtn.onclick = () => {
    settings.reloadOn = !settings.reloadOn;
    saveSettings();
    paintReload();
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
    const byScore = settings.sortBy === "score";
    // The icon states what you're looking at now, not what clicking would do.
    sortBtn.innerHTML = byScore ? ICON.star : ICON.clock;
    sortBtn.dataset.label = byScore ? "Best first" : "Newest first";
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
    filteredBtn.dataset.label = showHidden ? "Hiding rejects" : "Show filtered";
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

  // Icon-only makes a destructive click cheap, so require a second one.
  const clearBtn = panel.querySelector("#uwr-clear");
  let armed = null;
  clearBtn.onclick = () => {
    const disarm = () => {
      armed = null;
      clearBtn.innerHTML = ICON.trash;
      clearBtn.dataset.label = "Clear all";
      clearBtn.classList.remove("on");
    };
    if (!armed) {
      clearBtn.innerHTML = ICON.check;
      clearBtn.dataset.label = `Really clear ${jobs.length} jobs?`;
      clearBtn.classList.add("on");
      armed = setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(armed);
    disarm();
    jobs = [];
    saveJobs();
    setStatus("cleared");
    render();
  };

  setStatus(jobs.length ? `${jobs.length} jobs stored` : "hit ↻ to load the feed");
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
// query, and never throws away scroll position.
function refreshFeed() {
  // On the Saved searches tab, hop between the "All" chip and the saved-search
  // chip instead: each hop fires exactly one userSavedSearches query, and the
  // results are already filtered by your search and sorted newest first.
  const allChip = document.querySelector('[data-test="select-all"]');
  const searchChip = document.querySelector('[data-test="select-saved-search"]');
  if (allChip && searchChip) {
    const onSearch = /\/nx\/find-work\/\d+/.test(location.pathname);
    setStatus("refreshing…");
    (onSearch ? allChip : searchChip).click();
    countCheck(Date.now());
    return;
  }

  const recent = document.querySelector('[data-test="tab-most-recent"]');
  const best = document.querySelector('[data-test="tab-best-matches"]');
  if (!recent || !best) {
    setStatus("feed tabs not found — are you on Find Work?", "err");
    return;
  }
  // Clicking the tab you're already on is a no-op, so hop to the sibling and
  // stay there. One hop is one query -- the old bounce-and-return cost two per
  // refresh. Alternating still captures both feeds, one per check.
  const onBest = location.pathname.includes("best-matches");
  setStatus("refreshing…");
  (onBest ? recent : best).click();
  countCheck(Date.now());
}

// ---------- schedule ----------

// Pakistan Standard Time is UTC+5 all year (no DST since 2009), so a fixed
// offset is exact -- and the windows mean PKT whatever this machine's clock says.
const PKT_OFFSET_MS = 5 * 3600 * 1000;
const DAY_MS = 86400000;
// Never poll faster than this, whatever the setting says.
const GAP_FLOOR_MIN = 2;
// After 40-60 minutes of checking, step away for 10-20.
const SESSION_MIN = [40, 60];
const BREAK_MIN = [10, 20];
// Settings that change when auto-refresh may run; see the storage listener.
const SCHEDULE_KEYS = ["reloadOn", "schedule", "minGapMin", "maxGapMin", "dailyCap"];

const randomMs = ([lo, hi]) => Math.round((lo + Math.random() * (hi - lo)) * 60000);

function pktClock(now) {
  const shifted = now + PKT_OFFSET_MS;
  const sinceMidnight = ((shifted % DAY_MS) + DAY_MS) % DAY_MS;
  return {
    min: sinceMidnight / 60000,
    day: new Date(shifted).toISOString().slice(0, 10),
    midnight: now - sinceMidnight,
  };
}

// "14:00-17:00, 20:00-00:00" -> [[840, 1020], [1200, 1440]], in PKT minutes. An
// end at or before its start runs past midnight, so it is split in two.
function parseWindows(text) {
  const out = [];
  for (const part of String(text || "").split(",")) {
    const m = part.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (!m) continue;
    const start = +m[1] * 60 + +m[2];
    const end = +m[3] * 60 + +m[4];
    if (start >= 1440 || end > 1440) continue;
    if (end > start) out.push([start, end]);
    else {
      out.push([start, 1440]);
      if (end > 0) out.push([0, end]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function fmtPkt(min) {
  const h = Math.floor(min / 60) % 24;
  const m = Math.floor(min % 60);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function rollDay(day) {
  if (session.day === day) return;
  session = { day, checks: 0, activeSince: 0, sessionMs: 0, breakUntil: 0 };
  saveSession();
}

function countCheck(now) {
  rollDay(pktClock(now).day);
  session.checks++;
  saveSession();
}

// May an automatic check run right now? `until` is when the answer next changes
// (0 if unknown), which is what the countdown chip shows.
function autoGate(now) {
  const t = pktClock(now);
  rollDay(t.day);
  const windows = parseWindows(settings.schedule);
  const win = windows.find(([s, e]) => t.min >= s && t.min < e);

  if (!win) {
    // Leaving a window ends the session: the next one starts fresh, not mid-break.
    if (session.activeSince || session.breakUntil) {
      session.activeSince = session.breakUntil = 0;
      saveSession();
    }
    if (!windows.length) return { mode: "off", until: 0, text: "no active hours set — see popup" };
    const next = windows.find(([s]) => s > t.min);
    const start = next ? next[0] : windows[0][0];
    const until = t.midnight + (next ? 0 : DAY_MS) + start * 60000;
    return { mode: "off", until, text: `off hours — resumes ${fmtPkt(start)} PKT` };
  }

  const cap = settings.dailyCap || 80;
  if (session.checks >= cap) {
    return { mode: "cap", until: 0, text: `${cap} checks today — daily cap reached, resumes tomorrow` };
  }

  if (session.breakUntil > now) {
    const back = pktClock(session.breakUntil).min;
    return { mode: "break", until: session.breakUntil, text: `on a break — back around ${fmtPkt(back)} PKT` };
  }

  return { mode: "run", until: 0, text: `active until ${fmtPkt(win[1])} PKT · ${session.checks} checks today` };
}

function gapRangeMs() {
  const lo = Math.max(GAP_FLOOR_MIN, settings.minGapMin || 3);
  const hi = Math.max(lo, settings.maxGapMin || 8);
  return [lo * 60000, hi * 60000];
}

// Pick the wait before the next refresh.
//
// Someone thinking "I'll look again in a bit" is memoryless: having already
// waited two minutes tells you nothing about how much longer they'll wait. That
// property IS the exponential distribution, so that's what we sample -- truncated
// to the gap range. Most checks land early in the range, with a real tail out to
// the ceiling, and no two gaps alike.
function humanDelayMs() {
  const [min, max] = gapRangeMs();
  const span = max - min;
  if (span < 1000) return min;

  // lambda = 3/span puts the mean about a third of the way up the range, which
  // keeps it responsive without clustering on the floor.
  const lambda = 3 / span;
  const ceiling = 1 - Math.exp(-lambda * span); // renormalise for the truncation
  const x = -Math.log(1 - Math.random() * ceiling) / lambda;
  return Math.round(min + x);
}

let nextRefreshAt = 0;
let gate = null;

function startReload() {
  clearTimeout(reloadTimer);
  nextRefreshAt = 0;
  const was = gate && gate.mode;
  gate = null;
  if (!settings.reloadOn) return paintTick();

  const now = Date.now();
  gate = autoGate(now);
  // Say so when the mode changes; otherwise leave the status line to the feed.
  if (gate.mode !== was) setStatus(gate.text, gate.mode === "run" ? "ok" : "");

  if (gate.mode !== "run") {
    nextRefreshAt = gate.until;
    // Look again within a minute even when the resume time is hours off, so a
    // sleeping laptop or new hours from the popup can't strand it.
    const recheck = gate.until ? Math.min(60000, Math.max(1000, gate.until - now)) : 60000;
    reloadTimer = setTimeout(startReload, recheck);
    return paintTick();
  }

  const wait = humanDelayMs();
  nextRefreshAt = now + wait;
  paintTick();
  reloadTimer = setTimeout(autoCheck, wait); // re-rolled every time, never reused
}

function autoCheck() {
  const now = Date.now();
  // The wait may have carried us past the window's end or into the cap.
  if (autoGate(now).mode === "run") {
    if (!session.activeSince) {
      session.activeSince = now;
      session.sessionMs = randomMs(SESSION_MIN);
    }
    refreshFeed();
    if (now - session.activeSince >= session.sessionMs) {
      session.breakUntil = now + randomMs(BREAK_MIN);
      session.activeSince = 0;
    }
    saveSession();
  }
  startReload();
}

// Counts down to the real scheduled moment rather than a nominal interval --
// each wait is a fresh random draw, so there is no fixed number to display.
function paintTick() {
  const head = panel.querySelector("#uwr-tick");
  const rail = panel.querySelector("#uwr-mtick");
  if (!head) return;
  const mode = settings.reloadOn && gate ? gate.mode : "";
  let text = "";
  let short = "";
  if (mode === "cap") {
    text = short = "cap";
  } else if (mode && nextRefreshAt) {
    const s = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
    const h = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    const clock = h ? `${h}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
    const label = { break: "break ", off: "off " }[mode] || "";
    text = label + clock;
    short = h ? `${h}h` : `${mm}:${ss}`; // the rail is too narrow for h:mm:ss
  }
  const soon = mode === "run" && nextRefreshAt - Date.now() <= 10000; // green as it comes due
  for (const el of [head, rail]) {
    if (!el) continue;
    el.textContent = el === rail ? short : text;
    el.classList.toggle("soon", soon);
    el.classList.toggle("rest", mode === "break");
    el.classList.toggle("idle", mode === "off" || mode === "cap");
  }
}

setInterval(paintTick, 1000);

// Age chips go stale on a page that sits open.
setInterval(render, 30000);

load().then(() => {
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
});
