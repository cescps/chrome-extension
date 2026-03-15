const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── State ─────────────────────────────────────────────────────────────────────

let running = false;
let processedIds = new Set();
let postsCount = 0;
let postedOriginals = []; // last 50 source texts
let postedRewritten = []; // last 50 rewritten texts
let lastPostedText = '';
let lastPostedAt = null;
let currentStatus = 'Idle';

// ── Settings (loaded from storage, with defaults) ────────────────────────────

let settings = {
  apiKey: null,
  delayScan: 2,
  delayCompose: 0.4,
  delayPost: 1,
  similarity: 0.65
};

async function loadSettings() {
  return new Promise(resolve =>
    chrome.storage.sync.get(
      ['deepseekApiKey', 'delayScan', 'delayCompose', 'delayPost', 'similarity'],
      d => {
        settings.apiKey       = d.deepseekApiKey || null;
        settings.delayScan    = (d.delayScan    != null) ? d.delayScan    : 2;
        settings.delayCompose = (d.delayCompose != null) ? d.delayCompose : 0.4;
        settings.delayPost    = (d.delayPost    != null) ? d.delayPost    : 1;
        settings.similarity   = (d.similarity   != null) ? d.similarity   : 0.65;
        resolve(settings);
      }
    )
  );
}

// ── API ───────────────────────────────────────────────────────────────────────

async function callDeepSeek(text, apiKey) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'DEEPSEEK_REWRITE', text, apiKey }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res.success) return resolve(res.text);
      reject(new Error(res.error));
    });
  });
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

async function waitFor(selector, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(150);
  }
  return null;
}

function getPostId(article) {
  const link = article.querySelector('a[href*="/status/"]');
  if (link) {
    const m = link.href.match(/\/status\/(\d+)/);
    if (m) return m[1];
  }
  const textEl = article.querySelector('[data-testid="tweetText"]');
  return textEl ? textEl.innerText.trim().slice(0, 80) : null;
}

// ── Refresh feed ──────────────────────────────────────────────────────────────

function clickHome() {
  const home = document.querySelector('[data-testid="AppTabBar_Home_Link"]');
  if (home) home.click();
}

// ── Pick top N posts ──────────────────────────────────────────────────────────

function getTopPosts(n = 3) {
  return [...document.querySelectorAll('article[data-testid="tweet"]')]
    .filter(a => a.querySelector('[data-testid="tweetText"]'))
    .sort((a, b) =>
      (a.getBoundingClientRect().top + window.scrollY) -
      (b.getBoundingClientRect().top + window.scrollY)
    )
    .slice(0, n);
}

// ── Similarity checker ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','in','on','at','to','of',
  'and','or','for','with','by','from','that','this','as','it','its',
  'he','she','they','we','be','been','has','have','had','will','would',
  'could','should','but','not','no','so','if','about','over','after',
  'into','than','more','also','their','its','been','has','up','new'
]);

function tokenize(text) {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function isTooSimilar(candidateText, pool) {
  if (pool.length === 0) return false;
  const threshold = settings.similarity;
  const normalized = normalizeText(candidateText);
  const candidateWords = tokenize(candidateText);
  for (const posted of pool) {
    if (normalizeText(posted) === normalized) return true;
    const postedWords = tokenize(posted);
    const sim = jaccardSimilarity(candidateWords, postedWords);
    if (sim >= threshold) return true;
  }
  return false;
}

function isUndescribedMedia(text) {
  const hasMediaWord = /\b(video|videos|image|images|photo|photos|footage|clip|clips|picture|pictures|pic|pics)\b/i.test(text);
  if (!hasMediaWord) return false;
  const hasDescriptiveVerb = /\b(shows?|shown|reveals?|revealed|captures?|captured|depicts?|depicted|documents?|documented|demonstrates?|demonstrated|features?|featured|displays?|displayed|spotted|sees?|seen|emerges?\s+showing|showing)\b/i.test(text);
  return !hasDescriptiveVerb;
}

// ── Post flow ─────────────────────────────────────────────────────────────────

async function rewriteAndPost(tweetText, originalText) {
  setStatus('Fetching API key...');
  await loadSettings();
  if (!settings.apiKey) throw new Error('API key not set');

  setStatus('Rewriting...');
  const rewritten = await callDeepSeek(tweetText, settings.apiKey);

  if (isTooSimilar(rewritten, postedRewritten)) {
    throw new Error('Rewritten too similar to recent post — skipped');
  }

  setStatus('Opening composer...');
  const composeBtn =
    document.querySelector('[aria-label="Compose post"]') ||
    document.querySelector('[data-testid="SideNav_NewTweet_Button"]') ||
    document.querySelector('[aria-label="Post"]');
  if (!composeBtn) throw new Error('Compose button not found');
  composeBtn.click();
  await sleep(settings.delayCompose * 1000);

  const editor = await waitFor(
    'div[data-lexical-editor="true"], div[contenteditable="true"][role="textbox"]',
    6000
  );
  if (!editor) throw new Error('Editor not found');

  setStatus('Pasting text...');
  editor.focus();
  await sleep(80);

  // Clear any existing content in the editor before pasting
  const existingText = editor.textContent;
  if (existingText && existingText.trim().length > 0) {
    document.execCommand('selectAll', false, null);
    await sleep(50);
    document.execCommand('delete', false, null);
    await sleep(100);
  }

  // Write rewritten text to clipboard and paste from it
  // This ensures the clipboard always has the fresh text
  try {
    await navigator.clipboard.writeText(rewritten);
  } catch (_) {
    // Fallback: clipboard API may fail without focus
  }

  const dt = new DataTransfer();
  dt.setData('text/plain', rewritten);
  editor.dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true, cancelable: true, clipboardData: dt
  }));
  await sleep(250);

  // Verify the editor actually contains the new text
  const editorContent = editor.textContent.trim();
  const rewrittenNorm = rewritten.replace(/\s+/g, ' ').trim();
  const editorNorm = editorContent.replace(/\s+/g, ' ').trim();
  if (editorNorm !== rewrittenNorm) {
    console.warn('[AutoRewriter] Editor content mismatch, retrying paste...');
    // Select all and delete, then paste again
    document.execCommand('selectAll', false, null);
    await sleep(50);
    document.execCommand('delete', false, null);
    await sleep(100);
    editor.focus();
    const dt2 = new DataTransfer();
    dt2.setData('text/plain', rewritten);
    editor.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: dt2
    }));
    await sleep(250);
  }

  setStatus('Posting...');
  const postBtn = await (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const btn = [...document.querySelectorAll('button')].find(
        b => b.textContent.trim() === 'Post' &&
             !b.disabled &&
             b.getAttribute('aria-disabled') !== 'true'
      );
      if (btn) return btn;
      await sleep(150);
    }
    return null;
  })();

  if (!postBtn) throw new Error('Post button not found or disabled');
  postBtn.click();
  await sleep(settings.delayPost * 1000);

  // Detect "Whoops! You already said that." error
  const whoopsEl = [...document.querySelectorAll('*')].find(
    el => el.children.length === 0 && el.textContent.trim() === 'Whoops! You already said that.'
  );
  if (whoopsEl) {
    setStatus('Duplicate detected, discarding...');
    console.log('[AutoRewriter] "Already said that" error — going back');

    const backBtn =
      document.querySelector('[aria-label="Back"]') ||
      document.querySelector('[data-testid="app-bar-back"]') ||
      [...document.querySelectorAll('button')].find(b => b.querySelector('svg') && b.closest('header'));
    if (backBtn) backBtn.click();

    let discardBtn = null;
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      discardBtn = [...document.querySelectorAll('button')].find(
        b => b.textContent.trim() === 'Discard'
      );
      if (discardBtn) break;
    }
    if (discardBtn) {
      discardBtn.click();
      await sleep(500);
    } else {
      console.warn('[AutoRewriter] Discard button not found after waiting');
    }

    throw new Error('Already said that — skipped');
  }

  postsCount++;
  postedOriginals.push(originalText);
  if (postedOriginals.length > 50) postedOriginals.shift();
  postedRewritten.push(rewritten);
  if (postedRewritten.length > 50) postedRewritten.shift();
  lastPostedText = rewritten;
  lastPostedAt = Date.now();
  setStatus('Posted #' + postsCount);
  console.log('[AutoRewriter] Posted #' + postsCount + ':', rewritten.slice(0, 60));
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function runLoop() {
  // Reload settings at start and periodically
  await loadSettings();

  while (running) {
    const candidates = getTopPosts(3);
    let processed = false;

    for (const article of candidates) {
      const id = getPostId(article);
      if (!id || processedIds.has(id)) continue;

      const textEl = article.querySelector('[data-testid="tweetText"]');
      const text = textEl?.innerText.trim();
      if (!text) { processedIds.add(id); continue; }
      if (text.split(/\s+/).filter(Boolean).length < 2) { processedIds.add(id); continue; }
      if (isUndescribedMedia(text)) { processedIds.add(id); setStatus('Skipped (media without description)'); continue; }

      if (isTooSimilar(text, postedOriginals)) {
        processedIds.add(id);
        setStatus('Skipped (duplicate)');
        console.log('[AutoRewriter] Skipped duplicate post');
        processed = true;
        break;
      }

      processedIds.add(id);
      console.log('[AutoRewriter] New post detected');

      try {
        await rewriteAndPost(text, text);
        chrome.runtime.sendMessage({ type: 'CYCLE_DONE', postsCount }, () => {});
      } catch (err) {
        setStatus('Error: ' + err.message);
        console.error('[AutoRewriter]', err);
        await sleep(2000);
      }

      processed = true;
      break;
    }

    if (!processed) {
      setStatus('Scanning...');
    }

    clickHome();
    // Reload settings each cycle so changes take effect without restart
    await loadSettings();
    await sleep(settings.delayScan * 1000);
  }
}

// ── UI overlay ────────────────────────────────────────────────────────────────

function setStatus(msg) {
  currentStatus = msg;
  renderOverlay();
}

function relativeTime(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  return Math.floor(min / 60) + 'h ago';
}

function renderOverlay() {
  let el = document.getElementById('auto-rewriter-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'auto-rewriter-overlay';
    document.body.appendChild(el);
  }

  const stateLabel = running ? 'Running' : 'Idle';
  const stateColor = running ? '#56d364' : '#8b949e';
  const lastLine = lastPostedText
    ? `<div class="ar-last">${lastPostedText.slice(0, 45)}${lastPostedText.length > 45 ? '...' : ''}</div>
       <div class="ar-time">${relativeTime(lastPostedAt)}</div>`
    : `<div class="ar-time">No posts yet</div>`;

  el.innerHTML = `
    <div class="ar-header">
      <span class="ar-title">Auto Rewriter</span>
      <span class="ar-state" style="color:${stateColor}">${stateLabel}</span>
    </div>
    <div class="ar-divider"></div>
    <div class="ar-row"><span class="ar-label">Posts</span><span class="ar-val">${postsCount}</span></div>
    <div class="ar-row"><span class="ar-label">Last</span><div class="ar-last-wrap">${lastLine}</div></div>
    <div class="ar-divider"></div>
    <div class="ar-status">${currentStatus}</div>
  `;
}

setInterval(renderOverlay, 2000);

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.type === 'AUTO_TICK') {
    if (running) { sendResponse({ ok: true }); return true; }
    running = true;
    setStatus('Started');
    runLoop();
    sendResponse({ ok: true });
    return true;
  }

  if (req.type === 'AUTO_STOP') {
    running = false;
    setStatus('Stopped');
    sendResponse({ running: false, postsCount });
    return true;
  }

  if (req.type === 'AUTO_STATUS_REQ') {
    sendResponse({ running, postsCount });
    return true;
  }
});

renderOverlay();
