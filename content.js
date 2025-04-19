let reloadIntervalId = null;
let scrollIntervalId = null;

// Create buttons
const startReloadBtn = document.createElement("button");
const stopReloadBtn = document.createElement("button");
const startScrollBtn = document.createElement("button");
const stopScrollBtn = document.createElement("button");

// === Toast Notification ===
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

// === Button State Manager ===
function updateReloadButtonState() {
  const active = reloadIntervalId !== null;
  startReloadBtn.disabled = active;
  startReloadBtn.style.opacity = active ? "0.6" : "1";
  stopReloadBtn.disabled = !active;
  stopReloadBtn.style.opacity = !active ? "0.6" : "1";
}

function updateScrollButtonState() {
  const active = scrollIntervalId !== null;
  startScrollBtn.disabled = active;
  startScrollBtn.style.opacity = active ? "0.6" : "1";
  stopScrollBtn.disabled = !active;
  stopScrollBtn.style.opacity = !active ? "0.6" : "1";
}

// === Reload Logic ===
function startAutoReload() {
  if (reloadIntervalId) return;
  reloadIntervalId = setInterval(() => {
    location.reload();
  }, 20000);
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

// === Scroll Logic ===
function startAutoScroll() {
  if (scrollIntervalId) return;
  scrollIntervalId = setInterval(() => {
    window.scrollBy(0, 2);
    if ((window.innerHeight + window.scrollY) >= document.body.scrollHeight) {
      stopAutoScroll(); // Stop at bottom
    }
  }, 40);
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

// === Button Creation Utility ===
function createButton(btn, label, top, left, color, onClick) {
  btn.innerText = label;
  Object.assign(btn.style, {
    position: "fixed",
    top: top,
    left: left,
    background: color,
    color: "#fff",
    fontSize: "13px",
    fontFamily: "sans-serif",
    padding: "6px 10px",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    zIndex: "99999",
    opacity: "1",
  });
  btn.onclick = onClick;
  document.body.appendChild(btn);
}

// === Create and Attach Buttons ===
createButton(startReloadBtn, "▶ Start Reload", "10px", "10px", "#4CAF50", startAutoReload);
createButton(stopReloadBtn, "⏹ Stop Reload", "10px", "120px", "#f44336", stopAutoReload);
createButton(startScrollBtn, "⬇ Start Scroll", "45px", "10px", "#2196F3", startAutoScroll);
createButton(stopScrollBtn, "⏹ Stop Scroll", "45px", "120px", "#777", stopAutoScroll);

// === Auto Start on Load (if allowed) ===
if (localStorage.getItem("upworkReloadStopped") !== "true") {
  startAutoReload();
}
startAutoScroll(); // Always start scroll

// === Sync UI Button States ===
updateReloadButtonState();
updateScrollButtonState();
