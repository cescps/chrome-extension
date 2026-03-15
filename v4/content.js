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
let poolsReady = false;

// Restore similarity pools from storage so they survive page refreshes
const poolsLoaded = new Promise(resolve => {
  chrome.storage.local.get(['postedOriginals', 'postedRewritten'], d => {
    if (Array.isArray(d.postedOriginals)) postedOriginals = d.postedOriginals;
    if (Array.isArray(d.postedRewritten)) postedRewritten = d.postedRewritten;
    poolsReady = true;
    console.log('[AutoRewriter] Restored pools — originals:', postedOriginals.length, 'rewritten:', postedRewritten.length);
    resolve();
  });
});

function savePools() {
  chrome.storage.local.set({ postedOriginals, postedRewritten });
}

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
  'into','than','more','also','their','its','been','has','up','new',
  'says','said','just','may','can','get','got','now','out','per','via'
]);

function normalizeText(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Tokenize into meaningful words — keep 2-char words (US, UK, EU, UN, B2)
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
}

function tokenizeSet(text) {
  return new Set(tokenize(text));
}

// Jaccard: |A ∩ B| / |A ∪ B|
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

// Containment: what fraction of the smaller set is contained in the larger?
// Catches cases where one headline is a subset/rephrase of another
function containmentSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const smaller = Math.min(setA.size, setB.size);
  return intersection / smaller;
}

// Bigram overlap — catches phrase-level similarity that word-level misses
// "missile strike" and "missile strikes" share the bigram "missile strike/strikes"
function bigramSet(text) {
  const words = tokenize(text);
  const bigrams = new Set();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(words[i] + ' ' + words[i + 1]);
  }
  return bigrams;
}

function computeSimilarity(textA, textB) {
  const wordsA = tokenizeSet(textA);
  const wordsB = tokenizeSet(textB);
  const jaccard = jaccardSimilarity(wordsA, wordsB);
  const containment = containmentSimilarity(wordsA, wordsB);

  const bigramsA = bigramSet(textA);
  const bigramsB = bigramSet(textB);
  const bigramJaccard = (bigramsA.size > 0 || bigramsB.size > 0)
    ? jaccardSimilarity(bigramsA, bigramsB)
    : 0;

  // Combined score: weight containment and bigrams more than plain jaccard
  // because news headlines about the same event often rephrase with synonyms
  // but keep key entities (names, places, numbers)
  return Math.max(jaccard, containment * 0.85, bigramJaccard);
}

function isTooSimilar(candidateText, pool) {
  if (pool.length === 0) return false;
  const threshold = settings.similarity;
  const normalized = normalizeText(candidateText);

  let maxSim = 0;
  let maxMatch = '';

  for (const posted of pool) {
    // Exact normalized match
    if (normalizeText(posted) === normalized) {
      console.log('[AutoRewriter] Similarity: exact match found');
      return true;
    }

    const sim = computeSimilarity(candidateText, posted);
    if (sim > maxSim) { maxSim = sim; maxMatch = posted.slice(0, 60); }

    if (sim >= threshold) {
      console.log(`[AutoRewriter] Similarity: ${(sim * 100).toFixed(0)}% >= ${(threshold * 100).toFixed(0)}% — BLOCKED. Match: "${posted.slice(0, 60)}"`);
      return true;
    }
  }

  console.log(`[AutoRewriter] Similarity: best ${(maxSim * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}% — allowed. Closest: "${maxMatch}"`);
  return false;
}

function isUndescribedMedia(text) {
  const hasMediaWord = /\b(video|videos|image|images|photo|photos|footage|clip|clips|picture|pictures|pic|pics)\b/i.test(text);
  if (!hasMediaWord) return false;
  const hasDescriptiveVerb = /\b(shows?|shown|reveals?|revealed|captures?|captured|depicts?|depicted|documents?|documented|demonstrates?|demonstrated|features?|featured|displays?|displayed|spotted|sees?|seen|emerges?\s+showing|showing)\b/i.test(text);
  return !hasDescriptiveVerb;
}

// ── Cleanup helper — close any open compose modal/menu ───────────────────────

async function dismissComposer() {
  // Try the compose modal's Close button first (the X icon)
  const closeBtn =
    document.querySelector('[data-testid="app-bar-close"]') ||
    document.querySelector('div[role="dialog"] [aria-label="Close"]') ||
    document.querySelector('[aria-label="Close"]');

  if (closeBtn) {
    closeBtn.click();
    await sleep(400);

    // If a "Save post?" / "Discard" confirmation appears, click Discard
    const discardBtn = [...document.querySelectorAll('button')].find(
      b => b.textContent.trim() === 'Discard'
    );
    if (discardBtn) {
      discardBtn.click();
      await sleep(400);
    }
    return;
  }

  // Fallback: press Escape to close whatever is open
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true
  }));
  await sleep(400);

  // Check for discard confirmation after Escape too
  const discardBtn = [...document.querySelectorAll('button')].find(
    b => b.textContent.trim() === 'Discard'
  );
  if (discardBtn) {
    discardBtn.click();
    await sleep(400);
  }
}

// ── Post flow ─────────────────────────────────────────────────────────────────

async function rewriteAndPost(tweetText, originalText) {
  setStatus('Fetching API key...');
  await loadSettings();
  if (!settings.apiKey) throw new Error('API key not set');

  // Track source text immediately so similar tweets are caught even if this attempt fails
  postedOriginals.push(originalText);
  if (postedOriginals.length > 50) postedOriginals.shift();

  setStatus('Rewriting...');
  const rewritten = await callDeepSeek(tweetText, settings.apiKey);

  // Track the rewrite immediately so it's never retried, even on failure
  postedRewritten.push(rewritten);
  if (postedRewritten.length > 50) postedRewritten.shift();
  savePools();

  if (isTooSimilar(rewritten, postedRewritten.slice(0, -1))) {
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
  await sleep(120);

  // Clear editor only if it has leftover content from a prior attempt
  if (editor.textContent.trim().length > 0) {
    document.execCommand('selectAll', false, null);
    await sleep(50);
    document.execCommand('delete', false, null);
    await sleep(120);
  }

  // Insert text via execCommand — this goes through the browser's native
  // input pipeline that Lexical actually listens to, unlike synthetic
  // ClipboardEvents whose clipboardData is ignored on untrusted events.
  document.execCommand('insertText', false, rewritten);
  await sleep(250);

  // Verify the text was inserted correctly
  const editorNorm = editor.textContent.replace(/\s+/g, ' ').trim();
  const rewrittenNorm = rewritten.replace(/\s+/g, ' ').trim();
  if (editorNorm !== rewrittenNorm) {
    console.warn('[AutoRewriter] insertText failed, trying InputEvent fallback...');
    // Clear and retry with InputEvent
    document.execCommand('selectAll', false, null);
    await sleep(50);
    document.execCommand('delete', false, null);
    await sleep(120);

    // Fallback: dispatch an InputEvent which Lexical also handles
    editor.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: rewritten
    }));
    await sleep(250);

    const retryNorm = editor.textContent.replace(/\s+/g, ' ').trim();
    if (retryNorm !== rewrittenNorm) {
      console.error('[AutoRewriter] Both paste methods failed');
      await dismissComposer();
      throw new Error('Paste failed — editor has wrong content');
    }
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
    console.log('[AutoRewriter] "Already said that" error — dismissing composer');
    await dismissComposer();
    throw new Error('Already said that — skipped');
  }

  postsCount++;
  savePools();
  lastPostedText = rewritten;
  lastPostedAt = Date.now();
  setStatus('Posted #' + postsCount);
  console.log('[AutoRewriter] Posted #' + postsCount + ':', rewritten.slice(0, 60));
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function runLoop() {
  // Wait for pools + settings before first scan
  await poolsLoaded;
  await loadSettings();
  console.log(`[AutoRewriter] Starting with similarity threshold: ${(settings.similarity * 100).toFixed(0)}%, pool: ${postedOriginals.length} originals, ${postedRewritten.length} rewritten`);

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
        // Always clean up: dismiss any open composer/modal/menu before next cycle
        await dismissComposer();
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
