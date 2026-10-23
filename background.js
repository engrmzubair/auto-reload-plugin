// Desktop notifications + optional phone push. The content script does the
// scoring; this only handles what the page can't do itself.

const jobUrl = (j) =>
  j.ciphertext
    ? `https://www.upwork.com/nx/find-work/most-recent/details/${j.ciphertext}`
    : "https://www.upwork.com/nx/find-work/most-recent";

const openTargets = new Map();

function summarize(j) {
  const rate = j.hourlyStated
    ? `$${Math.round(j.hourlyMin)}-${Math.round(j.hourlyMax)}/hr`
    : j.fixedBudget
    ? `$${Math.round(j.fixedBudget)} fixed`
    : "rate unstated";
  const perHire = j.perHire ? `$${Math.round(j.perHire)}/hire` : "$?/hire";
  const spent =
    j.spent === null || j.spent === undefined
      ? "spend hidden"
      : j.spent >= 1000
      ? `$${(j.spent / 1000).toFixed(1)}K spent`
      : `$${Math.round(j.spent)} spent`;
  const applied = typeof j.applicants === "number" ? `${j.applicants} applied` : `${j.proposalsTier} proposals`;
  return `${rate} · ${perHire} · ${spent} · ${applied}`;
}

function notify(job) {
  const id = `uwr_${job.id}`;
  openTargets.set(id, jobUrl(job));
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "data:image/svg+xml;base64," + btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="24" fill="#14a800"/><text x="64" y="92" font-size="72" text-anchor="middle" fill="#fff" font-family="sans-serif">$</text></svg>'
    ),
    title: job.title.slice(0, 80),
    message: summarize(job),
    priority: 2,
    requireInteraction: true, // a notification you can miss is not an alarm
  });
}

// ntfy carries the title in an HTTP header, and headers must be Latin-1. Real
// Upwork titles are full of em-dashes, curly quotes and emoji -- passing one
// straight through makes fetch throw and the push silently never happens.
const asciiHeader = (s) =>
  String(s || "")
    .replace(/[‐-―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, 80) || "New Upwork job";

async function push(topic, job) {
  if (!topic) return { ok: false, error: "no topic set" };
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: {
        Title: asciiHeader(job.title),
        Priority: "high",
        Tags: "moneybag",
        Click: jobUrl(job),
      },
      body: summarize(job), // body is UTF-8, so the stats survive intact
    });
    if (!res.ok) return { ok: false, error: `ntfy returned ${res.status}` };
    return { ok: true };
  } catch (e) {
    console.warn("[radar] ntfy push failed:", e);
    return { ok: false, error: String(e.message || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "UWR_ALERT") return;
  for (const job of msg.jobs) notify(job);
  // Report the push result back so a failed topic is visible instead of silent.
  Promise.all(msg.jobs.map((job) => push(msg.ntfyTopic, job))).then((results) => {
    const failed = results.find((r) => r && !r.ok);
    sendResponse(failed || { ok: true, sent: results.length });
  });
  return true; // keep the channel open for the async reply
});

chrome.notifications.onClicked.addListener((id) => {
  const url = openTargets.get(id);
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(id);
  openTargets.delete(id);
});
