const baseEl = document.getElementById("base");
const keyEl = document.getElementById("key");
const statusEl = document.getElementById("status");

chrome.storage.sync.get(["mtConfig"], (res) => {
  const c = res.mtConfig || {};
  baseEl.value = c.base || "";
  keyEl.value = c.key || "";
});

document.getElementById("save").addEventListener("click", () => {
  const base = baseEl.value.trim().replace(/\/+$/, "");
  const key = keyEl.value.trim();
  chrome.storage.sync.set({ mtConfig: { base, key } }, () => {
    statusEl.textContent = "Saved.";
    setTimeout(() => (statusEl.textContent = ""), 1500);
  });
});
