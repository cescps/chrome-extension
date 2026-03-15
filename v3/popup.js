const apiKeyInput    = document.getElementById('apiKey');
const toggleBtn      = document.getElementById('toggleBtn');
const saveBtn        = document.getElementById('saveBtn');
const startBtn       = document.getElementById('startBtn');
const statusEl       = document.getElementById('status');
const postsCountEl   = document.getElementById('postsCount');
const stateLabelEl   = document.getElementById('stateLabel');
const delayScanInput = document.getElementById('delayScan');
const delayComposeInput = document.getElementById('delayCompose');
const delayPostInput = document.getElementById('delayPost');
const similarityInput = document.getElementById('similarity');
const similarityVal  = document.getElementById('similarityVal');

let visible = false;
let isRunning = false;

const DEFAULTS = {
  delayScan: 2,
  delayCompose: 0.4,
  delayPost: 1,
  similarity: 0.65
};

// ── Load saved settings ───────────────────────────────────────────────────────

chrome.storage.sync.get(
  ['deepseekApiKey', 'delayScan', 'delayCompose', 'delayPost', 'similarity'],
  d => {
    if (d.deepseekApiKey) apiKeyInput.value = d.deepseekApiKey;
    delayScanInput.value    = d.delayScan    ?? DEFAULTS.delayScan;
    delayComposeInput.value = d.delayCompose ?? DEFAULTS.delayCompose;
    delayPostInput.value    = d.delayPost    ?? DEFAULTS.delayPost;
    similarityInput.value   = d.similarity   ?? DEFAULTS.similarity;
    updateSimilarityLabel();
  }
);

// ── Similarity slider label ──────────────────────────────────────────────────

function updateSimilarityLabel() {
  similarityVal.textContent = Math.round(similarityInput.value * 100) + '%';
}
similarityInput.addEventListener('input', updateSimilarityLabel);

// ── Save settings ────────────────────────────────────────────────────────────

function saveSettings(showFeedback = false) {
  const key = apiKeyInput.value.trim();
  const data = {
    delayScan:    parseFloat(delayScanInput.value)    || DEFAULTS.delayScan,
    delayCompose: parseFloat(delayComposeInput.value) || DEFAULTS.delayCompose,
    delayPost:    parseFloat(delayPostInput.value)    || DEFAULTS.delayPost,
    similarity:   parseFloat(similarityInput.value)   || DEFAULTS.similarity
  };
  if (key) data.deepseekApiKey = key;
  chrome.storage.sync.set(data, () => {
    if (showFeedback) {
      statusEl.style.color = '#56d364';
      statusEl.textContent = 'Saved!';
      setTimeout(() => (statusEl.textContent = ''), 2000);
    }
  });
}

saveBtn.addEventListener('click', () => {
  if (!apiKeyInput.value.trim()) {
    statusEl.style.color = '#f85149';
    statusEl.textContent = 'Enter a valid API key.';
    return;
  }
  saveSettings(true);
});

// ── Show/hide API key ─────────────────────────────────────────────────────────

toggleBtn.addEventListener('click', () => {
  visible = !visible;
  apiKeyInput.type = visible ? 'text' : 'password';
  toggleBtn.textContent = visible ? 'Hide' : 'Show';
});

// ── Find X.com tab ────────────────────────────────────────────────────────────

async function getXTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*', '*://pro.x.com/*'] }, tabs => {
      resolve(tabs[0] || null);
    });
  });
}

// ── Inject content script if needed ──────────────────────────────────────────

async function ensureContentScript(tabId) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'AUTO_STATUS_REQ' }, res => {
      if (!chrome.runtime.lastError && res) return resolve(true);
      Promise.all([
        chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }),
        chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
      ]).then(() => setTimeout(() => resolve(true), 400)).catch(() => resolve(false));
    });
  });
}

// ── Status ────────────────────────────────────────────────────────────────────

function setUI(running, count) {
  isRunning = running;
  postsCountEl.textContent = count ?? 0;
  stateLabelEl.textContent = running ? 'Running' : 'Idle';
  stateLabelEl.style.color  = running ? '#56d364' : '#8b949e';
  startBtn.textContent = running ? 'Stop' : 'Start Auto';
  startBtn.className   = running ? 'running' : '';
}

async function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'AUTO_STATUS_REQ' }, res => {
    if (res) setUI(res.running, res.postsCount);
  });
}

refreshStatus();

// ── Start / Stop ──────────────────────────────────────────────────────────────

startBtn.addEventListener('click', async () => {
  if (isRunning) {
    chrome.runtime.sendMessage({ type: 'AUTO_STOP' }, res => {
      if (res) setUI(false, res.postsCount);
      statusEl.style.color = '#8b949e';
      statusEl.textContent = 'Stopped.';
      setTimeout(() => (statusEl.textContent = ''), 2000);
    });
    return;
  }

  // Save settings before starting
  saveSettings();

  const tab = await getXTab();
  if (!tab) {
    statusEl.style.color = '#f85149';
    statusEl.textContent = 'Open x.com in a tab first.';
    return;
  }

  statusEl.style.color = '#8b949e';
  statusEl.textContent = 'Connecting...';

  const ok = await ensureContentScript(tab.id);
  if (!ok) {
    statusEl.style.color = '#f85149';
    statusEl.textContent = 'Could not inject into x.com tab.';
    return;
  }

  chrome.runtime.sendMessage({
    type: 'AUTO_START',
    tabId: tab.id,
    windowId: tab.windowId
  }, res => {
    if (!res?.ok) {
      statusEl.style.color = '#f85149';
      statusEl.textContent = 'Failed to start.';
      return;
    }
    setUI(true, 0);
    statusEl.style.color = '#56d364';
    statusEl.textContent = 'Auto mode started!';
    setTimeout(() => (statusEl.textContent = ''), 2500);
  });
});

// ── Listen for status updates ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'AUTO_STATUS') setUI(msg.running, msg.postsCount);
});
