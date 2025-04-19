let reloadIntervalId = null;
let scrollIntervalId = null;
let reloadTime = 20000;
let scrollStep = 2;
let scrollDelay = 40;

let isCollapsed = false; // Track toggle state

// === Create UI Elements ===
const container = document.createElement("div");
const pinButton = document.createElement("button");
pinButton.innerText = "📌";
pinButton.title = "Collapse / Expand Toolbar";
pinButton.style.marginRight = "8px";

const controlWrapper = document.createElement("div");
const elements = {
  toggleReloadBtn: createButton("▶ Start Reload", "#4CAF50", () => toggleReload()),
  reloadSelect: createSelect(
    {
      "20s": 20000,
      "30s": 30000,
      "1 min": 60000
    },
    (value) => {
      reloadTime = parseInt(value);
      if (reloadIntervalId) {
        stopReload();
        startReload();
      }
    }
  ),
  toggleScrollBtn: createButton("⬇ Start Scroll", "#2196F3", () => toggleScroll()),
  scrollSelect: createSelect(
    {
      "Slow": JSON.stringify([1, 50]),
      "Medium": JSON.stringify([2, 40]),
      "Fast": JSON.stringify([4, 25])
    },
    (value) => {
      const [step, delay] = JSON.parse(value);
      scrollStep = step;
      scrollDelay = delay;
      if (scrollIntervalId) {
        stopScroll();
        startScroll();
      }
    }
  )
};

// === Toast Notification ===
function showToast(msg, color = "#333") {
  const toast = document.createElement("div");
  Object.assign(toast.style, toastStyle());
  toast.innerText = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => (toast.style.opacity = "1"));
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// === Button/Select Helpers ===
function createButton(label, color, onClick) {
  const btn = document.createElement("button");
  btn.innerText = label;
  Object.assign(btn.style, buttonStyle(color));
  btn.onclick = onClick;
  controlWrapper.appendChild(btn);
  return btn;
}

function createSelect(optionsObj, onChange) {
  const select = document.createElement("select");
  Object.entries(optionsObj).forEach(([label, value]) => {
    const opt = document.createElement("option");
    opt.text = label;
    opt.value = value;
    select.appendChild(opt);
  });
  Object.assign(select.style, selectStyle());
  select.onchange = (e) => onChange(e.target.value);
  controlWrapper.appendChild(select);
  return select;
}

// === Reload Logic ===
function startReload() {
  reloadIntervalId = setInterval(() => location.reload(), reloadTime);
  elements.toggleReloadBtn.innerText = "⏹ Stop Reload";
  elements.toggleReloadBtn.style.background = "#f44336";
  localStorage.removeItem("upworkReloadStopped");
  showToast("✅ Auto-reload started", "#4CAF50");
}

function stopReload() {
  clearInterval(reloadIntervalId);
  reloadIntervalId = null;
  elements.toggleReloadBtn.innerText = "▶ Start Reload";
  elements.toggleReloadBtn.style.background = "#4CAF50";
  localStorage.setItem("upworkReloadStopped", "true");
  showToast("🛑 Auto-reload stopped", "#f44336");
}

function toggleReload() {
  reloadIntervalId ? stopReload() : startReload();
}

// === Scroll Logic ===
function startScroll() {
  scrollIntervalId = setInterval(() => {
    window.scrollBy(0, scrollStep);
    if ((window.innerHeight + window.scrollY) >= document.body.scrollHeight) {
      stopScroll();
    }
  }, scrollDelay);
  elements.toggleScrollBtn.innerText = "⏹ Stop Scroll";
  elements.toggleScrollBtn.style.background = "#777";
  showToast("⬇️ Auto-scroll started", "#2196F3");
}

function stopScroll() {
  clearInterval(scrollIntervalId);
  scrollIntervalId = null;
  elements.toggleScrollBtn.innerText = "⬇ Start Scroll";
  elements.toggleScrollBtn.style.background = "#2196F3";
  showToast("🛑 Auto-scroll stopped", "#777");
}

function toggleScroll() {
  scrollIntervalId ? stopScroll() : startScroll();
}

// === Collapse / Expand Toolbar ===
pinButton.onclick = () => {
  isCollapsed = !isCollapsed;
  controlWrapper.style.display = isCollapsed ? "none" : "flex";
  pinButton.innerText = isCollapsed ? "📂" : "📌";
  pinButton.title = isCollapsed ? "Expand Toolbar" : "Collapse Toolbar";
};

// === Styling Helpers ===
function buttonStyle(bgColor) {
  return {
    background: bgColor,
    color: "#fff",
    fontSize: "12px",
    padding: "4px 8px",
    margin: "0 4px",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
  };
}

function selectStyle() {
  return {
    fontSize: "12px",
    padding: "2px 6px",
    margin: "0 6px",
  };
}

function toastStyle() {
  return {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    background: "#333",
    color: "#fff",
    padding: "6px 12px",
    borderRadius: "5px",
    fontSize: "14px",
    fontFamily: "sans-serif",
    zIndex: "99999",
    boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
    opacity: "0",
    transition: "opacity 0.3s",
  };
}

// === UI Container Styling ===
Object.assign(container.style, {
  position: "fixed",
  top: "10px",
  left: "10px",
  background: "#fff",
  border: "1px solid #ddd",
  borderRadius: "6px",
  padding: "6px 8px",
  fontFamily: "sans-serif",
  fontSize: "12px",
  display: "flex",
  alignItems: "center",
  zIndex: "99999",
  boxShadow: "0 2px 6px rgba(0,0,0,0.1)",
});

Object.assign(controlWrapper.style, {
  display: "flex",
  alignItems: "center",
  gap: "6px",
});

// === Build & Attach UI ===
container.appendChild(pinButton);
container.appendChild(controlWrapper);
document.body.appendChild(container);

// === Auto Start & Sync ===
if (localStorage.getItem("upworkReloadStopped") !== "true") {
  startReload();
}
startScroll();
