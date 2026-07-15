// Listens for feed responses captured by inject.js, scores them, keeps a
// permanent deduplicated feed in chrome.storage, and rings on a match.

const STORE_JOBS = "uwr_jobs";
const STORE_RULES = "uwr_rules";
const STORE_SETTINGS = "uwr_settings";
const MAX_JOBS = 400;

let jobs = [];
let rules = {};
let settings = { sound: true, speak: true, ntfyTopic: "", reloadMs: 30000, reloadOn: false };
let audioCtx = null;
let reloadTimer = null;

// ---------- storage ----------

function load() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORE_JOBS, STORE_RULES, STORE_SETTINGS], (r) => {
      jobs = r[STORE_JOBS] || [];
      rules = r[STORE_RULES] || {};
      settings = Object.assign(settings, r[STORE_SETTINGS] || {});
      resolve();
    });
  });
}

function saveJobs() {
  chrome.storage.local.set({ [STORE_JOBS]: jobs.slice(0, MAX_JOBS) });
}

function saveSettings() {
  chrome.storage.local.set({ [STORE_SETTINGS]: settings });
}

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

window.addEventListener("UWR_FEED", (e) => {
  const results = e.detail && e.detail.results;
  if (!Array.isArray(results)) return;

  const known = new Set(jobs.map((j) => j.id));
  const fresh = [];

  for (const raw of results) {
    const scored = window.UWR.evaluate(raw, rules);
    if (!scored.id || known.has(scored.id)) continue;
    // firstSeenAt is our own clock. It is more precise than the "24 minutes
    // ago" the page renders, and it survives reloads.
    scored.firstSeenAt = Date.now();
    scored.isNew = true;
    jobs.push(scored);
    known.add(scored.id);
    if (scored.verdict !== window.UWR.VERDICT.HIDE) fresh.push(scored);
  }

  if (!fresh.length) {
    render();
    return;
  }

  jobs.sort((a, b) => b.score - a.score);
  saveJobs();

  const rings = fresh.filter((j) => j.verdict === window.UWR.VERDICT.RING);
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
.uwr-card{background:#1b2027;border:1px solid #262c34;border-left-width:3px;border-radius:6px;padding:9px 10px;margin-bottom:7px}
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
#uwr-foot{padding:7px 12px;background:#0e1116;border-top:1px solid #262c34;display:flex;gap:6px;align-items:center}
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

  return `<div class="uwr-card ${j.verdict}">
    <a class="uwr-title" href="${url}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a>
    <div class="uwr-row">
      ${j.isNew ? chip("NEW", "uwr-new") : ""}
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

function render() {
  const list = panel.querySelector("#uwr-list");
  const count = panel.querySelector("#uwr-count");
  if (!list) return;
  const kept = jobs.filter((j) => j.verdict !== window.UWR.VERDICT.HIDE);
  const rings = kept.filter((j) => j.verdict === window.UWR.VERDICT.RING).length;
  const hidden = jobs.length - kept.length;
  count.textContent = `${rings} ring · ${kept.length} kept · ${hidden} filtered`;

  const shown = showHidden ? jobs : kept;
  list.innerHTML = shown.length
    ? shown.map(cardHtml).join("")
    : `<div class="uwr-empty">${
        jobs.length
          ? `All ${jobs.length} jobs were filtered out.<br>Hit “Filtered” to see why.`
          : "Nothing yet.<br>Reload the feed and matching jobs will collect here permanently."
      }</div>`;
}

panel.innerHTML = `
  <div id="uwr-head">
    <button id="uwr-grip" title="Collapse">❯</button>
    <b>Job Radar</b>
    <span id="uwr-count"></span>
  </div>
  <div id="uwr-list"></div>
  <div id="uwr-foot">
    <button id="uwr-reload">▶ Auto-reload</button>
    <button id="uwr-filtered" title="Show what the rules killed, and why">Filtered</button>
    <button id="uwr-test">🔔 Test</button>
    <button id="uwr-clear">Clear</button>
  </div>`;

function mount() {
  document.body.appendChild(panel);

  panel.querySelector("#uwr-grip").onclick = () => {
    panel.classList.toggle("collapsed");
    panel.querySelector("#uwr-grip").textContent = panel.classList.contains("collapsed") ? "❮" : "❯";
  };

  const reloadBtn = panel.querySelector("#uwr-reload");
  function paintReload() {
    reloadBtn.textContent = settings.reloadOn ? "⏹ Auto-reload" : "▶ Auto-reload";
    reloadBtn.classList.toggle("on", !!settings.reloadOn);
  }
  reloadBtn.onclick = () => {
    settings.reloadOn = !settings.reloadOn;
    saveSettings();
    paintReload();
    startReload();
  };
  paintReload();

  const filteredBtn = panel.querySelector("#uwr-filtered");
  filteredBtn.onclick = () => {
    showHidden = !showHidden;
    filteredBtn.classList.toggle("on", showHidden);
    render();
  };

  panel.querySelector("#uwr-test").onclick = () => {
    primeAudio();
    ring(2);
    speak({ title: "Test alert", hourlyStated: true, hourlyMin: 25, hourlyMax: 45, spent: 55466 });
  };

  panel.querySelector("#uwr-clear").onclick = () => {
    jobs = [];
    saveJobs();
    render();
  };

  render();
  startReload();
}

// The reload is only a trigger: it makes the SPA refetch the feed, which
// inject.js then reads. Jitter keeps it from looking like a metronome.
function startReload() {
  clearTimeout(reloadTimer);
  if (!settings.reloadOn) return;
  const jitter = settings.reloadMs * (0.85 + Math.random() * 0.3);
  reloadTimer = setTimeout(() => location.reload(), jitter);
}

// Age chips go stale on a page that sits open.
setInterval(render, 30000);

load().then(() => {
  jobs.forEach((j) => (j.isNew = false));
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
});
