let reloadIntervalId = null;
let scrollIntervalId = null;
let reloadTime = 20000; // default 20s
let scrollStep = 2;
let scrollDelay = 40;

// Create UI elements
const container = document.createElement("div");
const startReloadBtn = document.createElement("button");
const stopReloadBtn = document.createElement("button");
const reloadSelect = document.createElement("select");

const startScrollBtn = document.createElement("button");
const stopScrollBtn = document.createElement("button");
const scrollSelect = document.createElement("select");

// Toast Notification
function showToast(msg, color = "#333") {
  const toast = document.createElement("div");
  toast.innerText = msg;
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    background: color,
    color: "#fff",
    padding: "6px 12px",
    borderRadius: "5px",
    fontSize: "14px",
    fontFamily: "sans-serif",
    zIndex: "99999",
    boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
    opacity: "0",
    transition: "opacity 0.3s",
  });
  document.body.appendChild(toast);
  requestAnimationFrame(() => (toast.style.opacity = "1"));
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// Button States
function updateReloadButtonState() {
  const active = reloadIntervalId !== null;
  startReloadBtn.disabled = active;
  stopReloadBtn.disabled = !active;
}

function updateScrollButtonState() {
  const active = scrollIntervalId !== null;
  startScrollBtn.disabled = active;
  stopScrollBtn.disabled = !active;
}

// Auto Reload Logic
function startAutoReload() {
  if (reloadIntervalId) return;
  reloadIntervalId = setInterval(() => {
    location.reload();
  }, reloadTime);
  localStorage.removeItem("upworkReloadStopped");
  updateReloadButtonState();
  showToast("✅ Auto-reload started", "#4CAF50");
}

function stopAutoReload() {
  if (reloadIntervalId) {
    clearInterval(reloadIntervalId);
    reloadIntervalId = null;
    localStorage.setItem("upworkReloadStopped", "true");
    updateReloadButtonState();
    showToast("🛑 Auto-reload stopped", "#f44336");
  }
}

// Auto Scroll Logic
function startAutoScroll() {
  if (scrollIntervalId) return;
  scrollIntervalId = setInterval(() => {
    window.scrollBy(0, scrollStep);
    if ((window.innerHeight + window.scrollY) >= document.body.scrollHeight) {
      stopAutoScroll();
    }
  }, scrollDelay);
  updateScrollButtonState();
  showToast("⬇️ Auto-scroll started", "#2196F3");
}

function stopAutoScroll() {
  if (scrollIntervalId) {
    clearInterval(scrollIntervalId);
    scrollIntervalId = null;
    updateScrollButtonState();
    showToast("🛑 Auto-scroll stopped", "#777");
  }
}

// Helper to create buttons
function createButton(btn, text, color, onClick) {
  btn.innerText = text;
  Object.assign(btn.style, {
    background: color,
    color: "#fff",
    fontSize: "12px",
    padding: "4px 8px",
    margin: "0 4px",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
  });
  btn.onclick = onClick;
  container.appendChild(btn);
}

// Helper to create selects
function createSelect(select, options, onChange) {
  options.forEach(([label, value]) => {
    const opt = document.createElement("option");
    opt.text = label;
    opt.value = value;
    select.appendChild(opt);
  });
  Object.assign(select.style, {
    fontSize: "12px",
    padding: "2px 6px",
    margin: "0 6px",
  });
  select.onchange = onChange;
  container.appendChild(select);
}

// Build UI container
Object.assign(container.style, {
  position: "fixed",
  top: "10px",
  left: "10px",
  background: "#fff",
  border: "1px solid #ddd",
  borderRadius: "6px",
  padding: "6px 10px",
  fontFamily: "sans-serif",
  fontSize: "12px",
  display: "flex",
  alignItems: "center",
  gap: "6px",
  zIndex: "99999",
  boxShadow: "0 2px 6px rgba(0,0,0,0.1)",
});

// Buttons & Selects
createButton(startReloadBtn, "▶ Reload", "#4CAF50", startAutoReload);
createButton(stopReloadBtn, "⏹ Reload", "#f44336", stopAutoReload);
createSelect(reloadSelect, [
  ["20s", 20000],
  ["30s", 30000],
  ["1 min", 60000],
], (e) => {
  reloadTime = parseInt(e.target.value);
  if (reloadIntervalId) {
    stopAutoReload();
    startAutoReload();
  }
});

createButton(startScrollBtn, "⬇ Scroll", "#2196F3", startAutoScroll);
createButton(stopScrollBtn, "⏹ Scroll", "#777", stopAutoScroll);
createSelect(scrollSelect, [
  ["Slow", JSON.stringify([1, 50])],
  ["Medium", JSON.stringify([2, 40])],
  ["Fast", JSON.stringify([4, 25])],
], (e) => {
  const [step, delay] = JSON.parse(e.target.value);
  scrollStep = step;
  scrollDelay = delay;
  if (scrollIntervalId) {
    stopAutoScroll();
    startAutoScroll();
  }
});

// Add UI
document.body.appendChild(container);

// Auto start on load
if (localStorage.getItem("upworkReloadStopped") !== "true") {
  startAutoReload();
}
startAutoScroll();

// Sync UI state
updateReloadButtonState();
updateScrollButtonState();
