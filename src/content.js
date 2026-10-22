const TEST_ATTR = "data-quietest-test";
const SHOW_CLASS = "quietest-show-tests";
const REVIEW_PATH = /^(\/[^/]+\/[^/]+\/pull\/\d+)\/(files|changes|commits\/)/;
const DIFF_HREF = /#diff-([0-9a-f]{64})$/;
const TOGGLE_ID = "quietest-toggle";

const hashByPath = new Map();
const hiddenByPath = new Map();
let reviewKey = null;
let scanQueued = false;
let scanGeneration = 0;
let hideRules = null;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function syncReviewKey() {
  const match = location.pathname.match(REVIEW_PATH);
  const key = match ? match[1] : null;
  if (key !== reviewKey) {
    reviewKey = key;
    hashByPath.clear();
    hiddenByPath.clear();
    document.documentElement.classList.remove(SHOW_CLASS);
  }
  return key;
}

function diffLinks() {
  return [...document.querySelectorAll('a[href*="#diff-"]')]
    .map((link) => ({ link, hash: link.getAttribute("href").match(DIFF_HREF)?.[1] }))
    .filter(({ hash }) => hash);
}

function candidatePaths(links) {
  const paths = new Set();
  for (const el of document.querySelectorAll("[data-path], [data-file-path], [data-tagsearch-path]")) {
    paths.add(el.dataset.path || el.dataset.filePath || el.dataset.tagsearchPath);
  }
  for (const { link } of links) {
    paths.add(link.textContent.replace(/[‎‏]/g, "").trim());
  }
  for (const item of document.querySelectorAll('[role="treeitem"][id]')) {
    paths.add(item.id);
  }
  return [...paths].filter((path) => path && path.length <= MAX_PATH_LENGTH);
}

function isHiddenPath(path) {
  if (!hiddenByPath.has(path)) {
    hiddenByPath.set(path, Boolean(matchingRule(path, hideRules)));
  }
  return hiddenByPath.get(path);
}

function treeItemsByHash(links) {
  const items = new Map();
  for (const { link, hash } of links) {
    const item = link.closest('[role="treeitem"]');
    if (item) {
      items.set(hash, [...(items.get(hash) ?? []), item]);
    }
  }
  return items;
}

function testElements(path, hash, treeItems) {
  return [
    document.getElementById(`diff-${hash}`),
    document.getElementById(`file-tree-item-diff-${hash}`),
    document.getElementById(path)?.closest('[role="treeitem"]'),
    ...(treeItems.get(hash) ?? []),
  ].filter(Boolean);
}

function addEmptyDirectories(marked) {
  const parents = new Set();
  const parentsWithVisibleChild = new Set();
  for (const item of [...document.querySelectorAll('[role="treeitem"]')].reverse()) {
    if (parents.has(item) && !parentsWithVisibleChild.has(item)) {
      marked.add(item);
    }
    const parent = item.parentElement?.closest('[role="treeitem"]');
    if (parent) {
      parents.add(parent);
      if (!marked.has(item)) {
        parentsWithVisibleChild.add(parent);
      }
    }
  }
}

function applyMarks(marked) {
  for (const el of document.querySelectorAll(`[${TEST_ATTR}]`)) {
    if (!marked.has(el)) {
      el.removeAttribute(TEST_ATTR);
    }
  }
  for (const el of marked) {
    if (!el.hasAttribute(TEST_ATTR)) {
      el.setAttribute(TEST_ATTR, "");
    }
  }
}

function renderToggle(hiddenCount) {
  let button = document.getElementById(TOGGLE_ID);
  if (!button) {
    button = document.createElement("button");
    button.id = TOGGLE_ID;
    button.type = "button";
    button.dataset.testid = "quietest-toggle";
    button.innerHTML = `
      <svg class="quietest-toggle__quiet" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <defs>
          <linearGradient id="quietest-noise-mix" gradientUnits="userSpaceOnUse" x1="1.5" y1="0" x2="10" y2="0">
            <stop offset="0" class="quietest-toggle__mix-red"/>
            <stop offset="0.176" class="quietest-toggle__mix-red"/>
            <stop offset="0.176" class="quietest-toggle__mix-green"/>
            <stop offset="0.353" class="quietest-toggle__mix-green"/>
            <stop offset="0.353" class="quietest-toggle__mix-red"/>
            <stop offset="0.529" class="quietest-toggle__mix-red"/>
            <stop offset="0.529" class="quietest-toggle__mix-green"/>
            <stop offset="1" class="quietest-toggle__mix-green"/>
          </linearGradient>
        </defs>
        <polyline class="quietest-toggle__noise" points="1.5,12 3,9.5 4.5,14.5 6,10 7.5,12 10,12"/>
        <path class="quietest-toggle__signal" d="M10 12 Q13.25 5.5 16.5 12 T23 12"/>
        <line class="quietest-toggle__cut" x1="10" y1="4" x2="10" y2="20"/>
      </svg>
      <svg class="quietest-toggle__noisy" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <polyline class="quietest-toggle__noise" points="2,12 5,5 8,19 11,6 14,18 17,7 20,17 22,12"/>
      </svg>
      <span class="quietest-toggle__count"></span>`;
    button.addEventListener("click", () => {
      document.documentElement.classList.toggle(SHOW_CLASS);
      renderToggle(Number(button.dataset.hiddenCount));
    });
    document.body.append(button);
  }
  const showing = document.documentElement.classList.contains(SHOW_CLASS);
  button.dataset.hiddenCount = String(hiddenCount);
  button.hidden = hiddenCount === 0;
  button.setAttribute("aria-pressed", String(!showing));
  const files = hiddenCount === 1 ? "1 file" : `${hiddenCount} files`;
  const verb = hiddenCount === 1 ? "is" : "are";
  const tooltip = showing
    ? `${files} ${verb} adding noise. Click to hide them.`
    : `Quietest hid ${files} from this PR. Click to show them.`;
  button.dataset.tooltip = tooltip;
  button.setAttribute("aria-label", tooltip);
  const count = button.querySelector(".quietest-toggle__count");
  const countText = String(hiddenCount);
  if (count.textContent !== countText) {
    count.textContent = countText;
  }
}

function stopAfterExtensionUpdate() {
  observer.disconnect();
  applyMarks(new Set());
  document.getElementById(TOGGLE_ID)?.remove();
}

async function scan() {
  scanQueued = false;
  if (!chrome.runtime?.id) {
    stopAfterExtensionUpdate();
    return;
  }
  if (!hideRules) {
    return;
  }
  if (!syncReviewKey()) {
    document.getElementById(TOGGLE_ID)?.remove();
    return;
  }
  const generation = ++scanGeneration;
  const hiddenPaths = candidatePaths(diffLinks()).filter(isHiddenPath);
  const unhashedPaths = hiddenPaths.filter((path) => !hashByPath.has(path));
  if (unhashedPaths.length > 0) {
    const hashes = await Promise.all(unhashedPaths.map(sha256Hex));
    if (generation !== scanGeneration) {
      return;
    }
    unhashedPaths.forEach((path, index) => hashByPath.set(path, hashes[index]));
  }

  const treeItems = treeItemsByHash(diffLinks());
  const marked = new Set();
  let hiddenCount = 0;
  for (const path of hiddenPaths) {
    const elements = testElements(path, hashByPath.get(path), treeItems);
    for (const el of elements) {
      marked.add(el);
    }
    if (elements.length > 0) {
      hiddenCount += 1;
    }
  }
  addEmptyDirectories(marked);
  applyMarks(marked);
  renderToggle(hiddenCount);
}

function queueScan() {
  if (scanQueued) {
    return;
  }
  scanQueued = true;
  setTimeout(scan, 150);
}

async function refreshRules() {
  hideRules = activeRules(await loadSettings());
  hiddenByPath.clear();
  scanGeneration += 1;
  queueScan();
}

const observer = new MutationObserver(queueScan);
chrome.storage.onChanged.addListener(refreshRules);
observer.observe(document.documentElement, { childList: true, subtree: true });
refreshRules();
