const SYSTEM_PROMPT = `I will send a news headline. Convert it into this format and slightly reword it without changing the meaning. Prioritize clarity over exact length. I just want the headline rewritten, not explanation.

Start with the flags of the main countries mentioned (maximum 3). If the news is global or no specific country is mentioned, use 🌐 instead.

Follow with // as a separator.

Write in normal capitalization (not all caps).

Add "BREAKING:" only if the news is urgent.

Simplify punctuation and wording where needed for clarity.

Numbers, percentages, and dates should be clear and easy to read.

End the sentence with a period.

Do not add any information not present in the original headline.

Example:
Input: "Iran launches new wave of missiles towards Israel"
Output: 🇮🇷🇮🇱 // Iran launches new wave of missiles towards Israel.`;

// ── State ─────────────────────────────────────────────────────────────────────

let auto = { running: false, tabId: null, windowId: null, postsCount: 0 };

// Restore state if service worker was killed and restarted.
// Also recreate the alarm and trigger a cycle immediately — this fixes the race
// where the alarm fires before storage resolves, causing triggerCycle() to see
// auto.running === false and bail out, leaving the content script loop dead.
chrome.storage.local.get('autoState', d => {
  if (d.autoState) {
    auto = d.autoState;
    if (auto.running) {
      chrome.alarms.create('auto-keepalive', { periodInMinutes: 1 });
      triggerCycle();
    }
  }
});

function saveAuto() {
  chrome.storage.local.set({ autoState: auto });
}

// ── Alarm-based cycle trigger ─────────────────────────────────────────────────

async function triggerCycle() {
  if (!auto.running || !auto.tabId) return;
  try {
    chrome.tabs.sendMessage(auto.tabId, { type: 'AUTO_TICK' }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[AutoRewriter BG] Content script not ready:', chrome.runtime.lastError.message);
      }
    });
  } catch (err) {
    console.error('[AutoRewriter BG]', err);
  }
}

// ── Alarm keepalive (re-pings content script every minute) ───────────────────

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'auto-keepalive') triggerCycle();
});

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  if (req.type === 'DEEPSEEK_REWRITE') {
    callDeepSeek(req.text, req.apiKey)
      .then(text => sendResponse({ success: true, text }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (req.type === 'AUTO_START') {
    auto = { running: true, tabId: req.tabId, windowId: req.windowId, postsCount: 0 };
    saveAuto();
    chrome.alarms.create('auto-keepalive', { periodInMinutes: 1 });
    triggerCycle();
    sendResponse({ ok: true });
    return true;
  }

  if (req.type === 'AUTO_STOP') {
    auto.running = false;
    saveAuto();
    chrome.alarms.clear('auto-keepalive');
    if (auto.tabId) {
      chrome.tabs.sendMessage(auto.tabId, { type: 'AUTO_STOP' }).catch(() => {});
    }
    sendResponse({ ok: true, postsCount: auto.postsCount });
    return true;
  }

  if (req.type === 'CYCLE_DONE') {
    auto.postsCount = req.postsCount;
    saveAuto();
    sendResponse({ ok: true });
    return true;
  }

  if (req.type === 'AUTO_STATUS_REQ') {
    sendResponse({ running: auto.running, postsCount: auto.postsCount });
    return true;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callDeepSeek(text, apiKey) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text }
      ],
      max_tokens: 200,
      temperature: 0.3
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${res.status}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}
