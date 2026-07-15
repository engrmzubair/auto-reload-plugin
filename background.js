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
  const spent = j.spent >= 1000 ? `$${(j.spent / 1000).toFixed(1)}K spent` : `$${Math.round(j.spent)} spent`;
  return `${rate} · ${perHire} · ${spent} · ${j.proposalsTier} proposals`;
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

async function push(topic, job) {
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: {
        Title: job.title.slice(0, 80),
        Priority: "high",
        Tags: "moneybag",
        Click: jobUrl(job),
      },
      body: summarize(job),
    });
  } catch (e) {
    console.warn("[radar] ntfy push failed:", e);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "UWR_ALERT") {
    for (const job of msg.jobs) {
      notify(job);
      push(msg.ntfyTopic, job);
    }
  }
});

chrome.notifications.onClicked.addListener((id) => {
  const url = openTargets.get(id);
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(id);
  openTargets.delete(id);
});
