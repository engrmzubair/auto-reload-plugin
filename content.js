let reloadIntervalId = null;
let scrollIntervalId = null;

let reloadTime = parseInt(localStorage.getItem("reloadTime")) || 20000;
let [scrollStep, scrollDelay] = JSON.parse(localStorage.getItem("scrollSpeed") || "[2,40]");
let isCollapsed = localStorage.getItem("toolbarCollapsed") === "true";
let scrollInitiallyOn = localStorage.getItem("scrollOn") !== "false";
let isDarkMode = localStorage.getItem("toolbarDarkMode") === "true";

// === UI ELEMENTS ===
const container = document.createElement("div");
const pinButton = document.createElement("button");
pinButton.innerText = isCollapsed ? "📂" : "📌";
pinButton.title = isCollapsed ? "Expand Toolbar" : "Collapse Toolbar";

const controlWrapper = document.createElement("div");
Object.assign(controlWrapper.style, {
  display: isCollapsed ? "none" : "flex",
  alignItems: "center",
  gap: "6px",
});

const elements = {
  toggleReloadBtn: createButton("▶ Start Reload", "#4CAF50", toggleReload),
  reloadSelect: createSelect(
    {
      "20s": 20000,
      "30s": 30000,
      "1 min": 60000,
    },
    (value) => {
      reloadTime = parseInt(value);
      localStorage.setItem("reloadTime", reloadTime);
      if (reloadIntervalId) {
        stopReload();
        startReload();
      }
    },
    reloadTime
  ),
  toggleScrollBtn: createButton("⬇ Start Scroll", "#2196F3", toggleScroll),
  scrollSelect: createSelect(
    {
      "Slow": JSON.stringify([1, 50]),
      "Medium": JSON.stringify([2, 40]),
      "Fast": JSON.stringify([4, 25]),
    },
    (value) => {
      [scrollStep, scrollDelay] = JSON.parse(value);
      localStorage.setItem("scrollSpeed", value);
      if (scrollIntervalId) {
        stopScroll();
        startScroll();
      }
    },
    JSON.stringify([scrollStep, scrollDelay])
  ),
  darkToggle: createButton(isDarkMode ? "☀ Light Mode" : "🌙 Dark Mode", "#555", toggleDarkMode)
};

// === MAIN FUNCTIONS ===
function toggleReload() {
  reloadIntervalId ? stopReload() : startReload();
}
function toggleScroll() {
  scrollIntervalId ? stopScroll() : startScroll();
}
function toggleDarkMode() {
  isDarkMode = !isDarkMode;
  localStorage.setItem("toolbarDarkMode", isDarkMode);
  applyTheme();
  elements.darkToggle.innerText = isDarkMode ? "☀ Light Mode" : "🌙 Dark Mode";
}

// === TOAST ===
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

// === BUTTON / SELECT HELPERS ===
function createButton(label, color, onClick) {
  const btn = document.createElement("button");
  btn.innerText = label;
  Object.assign(btn.style, buttonStyle(color));
  btn.onclick = onClick;
  controlWrapper.appendChild(btn);
  return btn;
}
function createSelect(optionsObj, onChange, defaultValue) {
  const select = document.createElement("select");
  Object.entries(optionsObj).forEach(([label, value]) => {
    const opt = document.createElement("option");
    opt.text = label;
    opt.value = value;
    if (value == defaultValue) opt.selected = true;
    select.appendChild(opt);
  });
  Object.assign(select.style, selectStyle());
  select.onchange = (e) => onChange(e.target.value);
  controlWrapper.appendChild(select);
  return select;
}

// === AUTO RELOAD ===
function startReload() {
  reloadIntervalId = setInterval(() => location.reload(), reloadTime);
  elements.toggleReloadBtn.innerText = "⏹ Stop Reload";
  elements.toggleReloadBtn.style.background = "#f44336";
  localStorage.setItem("reloadOn", "true");
  showToast("✅ Auto-reload started", "#4CAF50");
}
function stopReload() {
  clearInterval(reloadIntervalId);
  reloadIntervalId = null;
  elements.toggleReloadBtn.innerText = "▶ Start Reload";
  elements.toggleReloadBtn.style.background = "#4CAF50";
  localStorage.setItem("reloadOn", "false");
  showToast("🛑 Auto-reload stopped", "#f44336");
}

// === AUTO SCROLL ===
function startScroll() {
  scrollIntervalId = setInterval(() => {
    window.scrollBy(0, scrollStep);
    if ((window.innerHeight + window.scrollY) >= document.body.scrollHeight) {
      stopScroll();
    }
  }, scrollDelay);
  elements.toggleScrollBtn.innerText = "⏹ Stop Scroll";
  elements.toggleScrollBtn.style.background = "#777";
  localStorage.setItem("scrollOn", "true");
  showToast("⬇️ Auto-scroll started", "#2196F3");
}
function stopScroll() {
  clearInterval(scrollIntervalId);
  scrollIntervalId = null;
  elements.toggleScrollBtn.innerText = "⬇ Start Scroll";
  elements.toggleScrollBtn.style.background = "#2196F3";
  localStorage.setItem("scrollOn", "false");
  showToast("🛑 Auto-scroll stopped", "#777");
}

// === THEME + COLLAPSE TOGGLE ===
function applyTheme() {
  const isDark = localStorage.getItem("toolbarDarkMode") === "true";
  container.style.background = isDark ? "#2c2c2c" : "#fff";
  container.style.border = isDark ? "1px solid #555" : "1px solid #ddd";
  container.style.color = isDark ? "#eee" : "#000";
}
pinButton.onclick = () => {
  isCollapsed = !isCollapsed;
  controlWrapper.style.display = isCollapsed ? "none" : "flex";
  pinButton.innerText = isCollapsed ? "📂" : "📌";
  pinButton.title = isCollapsed ? "Expand Toolbar" : "Collapse Toolbar";
  localStorage.setItem("toolbarCollapsed", isCollapsed);
};

// === STYLING HELPERS ===
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

// === UI LAYOUT ===
Object.assign(container.style, {
  position: "fixed",
  top: "10px",
  left: "10px",
  borderRadius: "6px",
  padding: "6px 8px",
  fontFamily: "sans-serif",
  fontSize: "12px",
  display: "flex",
  alignItems: "center",
  zIndex: "99999",
  boxShadow: "0 2px 6px rgba(0,0,0,0.1)",
});
applyTheme();

// === BUILD UI ===
container.appendChild(pinButton);
container.appendChild(controlWrapper);
document.body.appendChild(container);

// === AUTO START ===
if (localStorage.getItem("reloadOn") === "true") startReload();
if (scrollInitiallyOn) startScroll();

// === BACK TO TOP BUTTON ===
const backToTopBtn = document.createElement("button");
backToTopBtn.innerText = "⬆";
Object.assign(backToTopBtn.style, {
  position: "fixed",
  bottom: "20px",
  left: "20px",
  width: "36px",
  height: "36px",
  background: "#444",
  color: "#fff",
  border: "none",
  borderRadius: "50%",
  fontSize: "18px",
  cursor: "pointer",
  boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
  zIndex: "99999",
  display: "none", // Hidden by default
});
backToTopBtn.title = "Back to top";
backToTopBtn.onclick = () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
};
document.body.appendChild(backToTopBtn);

// Show button only when scrolled down
window.addEventListener("scroll", () => {
  backToTopBtn.style.display = window.scrollY > 300 ? "block" : "none";
});

