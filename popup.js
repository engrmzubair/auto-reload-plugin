const RULE_FIELDS = ["minFixedBudget", "minHourlyRate", "minClientSpend", "ringMinPerHire"];
const DEFAULT_RULES = { minFixedBudget: 1000, minHourlyRate: 15, minClientSpend: 2000, ringMinPerHire: 100 };
const DEFAULT_SETTINGS = {
  sound: true,
  speak: true,
  ntfyTopic: "",
  reloadMs: 30000,
  ringMaxAgeMin: 60,
  maxAgeHours: 24,
};

chrome.storage.local.get(["uwr_rules", "uwr_settings"], (r) => {
  const rules = Object.assign({}, DEFAULT_RULES, r.uwr_rules || {});
  const settings = Object.assign({}, DEFAULT_SETTINGS, r.uwr_settings || {});
  RULE_FIELDS.forEach((k) => (document.getElementById(k).value = rules[k]));
  document.getElementById("sound").checked = settings.sound;
  document.getElementById("speak").checked = settings.speak;
  document.getElementById("ntfyTopic").value = settings.ntfyTopic;
  document.getElementById("ringMaxAgeMin").value = settings.ringMaxAgeMin;
  document.getElementById("maxAgeHours").value = settings.maxAgeHours;
  document.getElementById("reloadSec").value = Math.round(settings.reloadMs / 1000);
});

const num = (id, fallback) => {
  const n = parseFloat(document.getElementById(id).value);
  return isFinite(n) && n > 0 ? n : fallback;
};

document.getElementById("save").onclick = () => {
  const rules = {};
  RULE_FIELDS.forEach((k) => {
    const n = parseFloat(document.getElementById(k).value);
    rules[k] = isFinite(n) ? n : DEFAULT_RULES[k];
  });

  const seconds = parseInt(document.getElementById("reloadSec").value, 10);
  chrome.storage.local.get(["uwr_settings"], (r) => {
    const settings = Object.assign({}, DEFAULT_SETTINGS, r.uwr_settings || {}, {
      sound: document.getElementById("sound").checked,
      speak: document.getElementById("speak").checked,
      ntfyTopic: document.getElementById("ntfyTopic").value.trim(),
      ringMaxAgeMin: num("ringMaxAgeMin", DEFAULT_SETTINGS.ringMaxAgeMin),
      maxAgeHours: num("maxAgeHours", DEFAULT_SETTINGS.maxAgeHours),
      // Don't let a typo turn this into a hammer on Upwork's servers.
      reloadMs: Math.max(15, isFinite(seconds) ? seconds : 30) * 1000,
    });
    chrome.storage.local.set({ uwr_rules: rules, uwr_settings: settings }, () => {
      const el = document.getElementById("saved");
      el.textContent = "Saved — reload the Upwork tab";
      setTimeout(() => (el.textContent = ""), 2500);
    });
  });
};
