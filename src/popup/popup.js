const nameInput = document.getElementById("token-name");
const tokenInput = document.getElementById("token");
const saveButton = document.getElementById("save");
const tokenList = document.getElementById("token-list");
const status = document.getElementById("status");

initialize().catch((error) => {
  status.textContent = error instanceof Error ? error.message : "Unable to load saved tokens.";
});

saveButton.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  const token = tokenInput.value.trim();
  await sendMessage({ type: "stc:save-token", name, token });
  nameInput.value = "";
  tokenInput.value = "";
  status.textContent = "Token saved.";
  await renderTokens();
});

async function initialize() {
  await renderTokens();
}

async function renderTokens() {
  const response = await sendMessage({ type: "stc:get-state" });
  const tokens = response.state.tokens || [];

  if (!tokens.length) {
    tokenList.innerHTML = '<p class="popup__empty">No saved tokens yet.</p>';
    return;
  }

  tokenList.innerHTML = tokens
    .map(
      (entry) => `
        <div class="popup__token-item">
          <div class="popup__token-copy">
            <div class="popup__token-name">${escapeHtml(entry.name)}</div>
            <div class="popup__token-mask">${maskToken(entry.token)}</div>
          </div>
          <button class="popup__token-delete" type="button" data-token-id="${escapeHtml(entry.id)}">Delete</button>
        </div>
      `
    )
    .join("");

  for (const button of tokenList.querySelectorAll("[data-token-id]")) {
    button.addEventListener("click", async () => {
      await sendMessage({ type: "stc:delete-token", id: button.dataset.tokenId });
      status.textContent = "Token deleted.";
      await renderTokens();
    });
  }
}

function maskToken(token) {
  const value = String(token || "");
  if (value.length <= 8) {
    return "Saved token";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed"));
        return;
      }
      resolve(response);
    });
  });
}
