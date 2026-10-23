const RULE_FIELDS = ["minFixedBudget", "minHourlyRate", "minClientSpend", "ringMinPerHire", "ringMaxApplicants"];
const DEFAULT_RULES = {
  minFixedBudget: 1000,
  minHourlyRate: 15,
  minClientSpend: 2000,
  ringMinPerHire: 100,
  ringMaxApplicants: 20,
};
const DEFAULT_SETTINGS = {
  sound: true,
  speak: true,
  ntfyTopic: "",
  refreshMode: "recent-saved",
  schedule: "14:00-17:00, 20:00-00:00",
  minGapMin: 3,
  maxGapMin: 8,
  dailyCap: 80,
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
  document.getElementById("refreshMode").value = settings.refreshMode;
  document.getElementById("schedule").value = settings.schedule;
  document.getElementById("minGapMin").value = settings.minGapMin;
  document.getElementById("maxGapMin").value = settings.maxGapMin;
  document.getElementById("dailyCap").value = settings.dailyCap;
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

  // 2 minutes is the hard floor -- a typo must never be able to turn this into a
  // hammer. The page enforces it too.
  const minGap = Math.max(2, num("minGapMin", DEFAULT_SETTINGS.minGapMin));
  const maxGap = Math.max(minGap, num("maxGapMin", DEFAULT_SETTINGS.maxGapMin));
  chrome.storage.local.get(["uwr_settings"], (r) => {
    const settings = Object.assign({}, DEFAULT_SETTINGS, r.uwr_settings || {}, {
      sound: document.getElementById("sound").checked,
      speak: document.getElementById("speak").checked,
      ntfyTopic: document.getElementById("ntfyTopic").value.trim(),
      ringMaxAgeMin: num("ringMaxAgeMin", DEFAULT_SETTINGS.ringMaxAgeMin),
      maxAgeHours: num("maxAgeHours", DEFAULT_SETTINGS.maxAgeHours),
      refreshMode: document.getElementById("refreshMode").value,
      schedule: document.getElementById("schedule").value.trim() || DEFAULT_SETTINGS.schedule,
      minGapMin: minGap,
      maxGapMin: maxGap,
      dailyCap: Math.round(num("dailyCap", DEFAULT_SETTINGS.dailyCap)),
    });
    delete settings.reloadMs; // replaced by the minute range above
    chrome.storage.local.set({ uwr_rules: rules, uwr_settings: settings }, () => {
      const el = document.getElementById("saved");
      el.textContent = "Saved";
      setTimeout(() => (el.textContent = ""), 2500);
    });
  });
};
