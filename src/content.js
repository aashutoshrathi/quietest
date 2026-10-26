const TEST_ATTR = "data-quietest-test";
const IMPL_ATTR = "data-quietest-impl";
const REVIEW_PATH = /^(\/[^/]+\/[^/]+\/pull\/\d+)\/(files|changes|commits\/)/;
const DIFF_HREF = /#diff-([0-9a-f]{64})$/;
const TOGGLE_ID = "quietest-toggle";
const MODES = [
  { id: "implementation", label: "Show implementation", hides: "test" },
  { id: "tests", label: "Show tests", hides: "implementation" },
  { id: "both", label: "Show both", hides: null },
];
const DEFAULT_MODE = MODES[0].id;

const hashByPath = new Map();
const hiddenByPath = new Map();
let reviewKey = null;
let scanQueued = false;
let scanGeneration = 0;
let hideRules = null;
let counts = { test: 0, implementation: 0 };

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
    setMode(DEFAULT_MODE);
  }
  return key;
}

function currentMode() {
  return document.documentElement.dataset.quietestMode || DEFAULT_MODE;
}

function setMode(mode) {
  document.documentElement.dataset.quietestMode = mode;
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

function diffEntry(hash) {
  const diff = document.getElementById(`diff-${hash}`);
  if (diff?.parentElement?.childElementCount === 1) {
    return diff.parentElement;
  }
  return diff;
}

function diffElements(hash, treeItems) {
  return [
    diffEntry(hash),
    document.getElementById(`file-tree-item-diff-${hash}`),
    ...(treeItems.get(hash) ?? []),
  ].filter(Boolean);
}

function pathTreeItem(path) {
  return document.getElementById(path)?.closest('[role="treeitem"]');
}

function testElements(path, hash, treeItems) {
  return [...diffElements(hash, treeItems), pathTreeItem(path)].filter(Boolean);
}

// Only paths backed by a diff count as implementation files, so directory ids in the tree are never marked.
function implementationElements(path, hash, treeItems) {
  const elements = diffElements(hash, treeItems);
  return elements.length > 0 ? [...elements, pathTreeItem(path)].filter(Boolean) : [];
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

function applyMarks(attr, marked) {
  for (const el of document.querySelectorAll(`[${attr}]`)) {
    if (!marked.has(el)) {
      el.removeAttribute(attr);
    }
  }
  for (const el of marked) {
    if (!el.hasAttribute(attr)) {
      el.setAttribute(attr, "");
    }
  }
}

function pluralFiles(count, kind) {
  return count === 1 ? `1 ${kind} file` : `${count} ${kind} files`;
}

function hiddenCount(mode) {
  const hides = MODES.find((entry) => entry.id === mode)?.hides;
  return hides ? counts[hides] : 0;
}

function setMenuOpen(root, open) {
  root.classList.toggle("quietest-toggle--open", open);
  root.querySelector(".quietest-toggle__button").setAttribute("aria-expanded", String(open));
}

function createToggle() {
  const root = document.createElement("div");
  root.id = TOGGLE_ID;
  root.innerHTML = `
    <div class="quietest-toggle__menu" role="menu" aria-label="Quietest view">
      ${MODES.map(
        (mode) => `
        <button type="button" role="menuitemradio" class="quietest-toggle__item" data-mode="${mode.id}">
          <span class="quietest-toggle__check" aria-hidden="true"></span>
          <span class="quietest-toggle__label">${mode.label}</span>
          <span class="quietest-toggle__hint"></span>
        </button>`,
      ).join("")}
    </div>
    <button type="button" class="quietest-toggle__button" data-testid="quietest-toggle" aria-haspopup="menu" aria-expanded="false">
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
      <svg class="quietest-toggle__tests" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path class="quietest-toggle__flask" d="M9 3h6M10 3v6l-5.2 9.1A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-2.9L14 9V3"/>
        <line class="quietest-toggle__liquid" x1="7.5" y1="15" x2="16.5" y2="15"/>
      </svg>
      <svg class="quietest-toggle__noisy" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <polyline class="quietest-toggle__noise" points="2,12 5,5 8,19 11,6 14,18 17,7 20,17 22,12"/>
      </svg>
    </button>
    <span class="quietest-toggle__badge" aria-hidden="true"></span>`;

  root.querySelector(".quietest-toggle__button").addEventListener("click", () => {
    setMenuOpen(root, !root.classList.contains("quietest-toggle--open"));
  });
  for (const item of root.querySelectorAll(".quietest-toggle__item")) {
    item.addEventListener("click", () => {
      setMode(item.dataset.mode);
      setMenuOpen(root, false);
      renderToggle();
      root.querySelector(".quietest-toggle__button").focus();
    });
  }
  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) {
      setMenuOpen(root, false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.classList.contains("quietest-toggle--open")) {
      setMenuOpen(root, false);
      root.querySelector(".quietest-toggle__button").focus();
    }
  });
  document.body.append(root);
  return root;
}

function renderToggle() {
  const root = document.getElementById(TOGGLE_ID) ?? createToggle();
  const mode = currentMode();
  const hidden = hiddenCount(mode);
  root.hidden = counts.test === 0 && mode !== "tests";
  root.dataset.mode = mode;

  const button = root.querySelector(".quietest-toggle__button");
  const hides = MODES.find((entry) => entry.id === mode).hides;
  const tooltip =
    hidden > 0 ? `Quietest hid ${pluralFiles(hidden, hides)} from this PR.` : "Quietest is showing every file in this PR.";
  button.dataset.tooltip = tooltip;
  button.setAttribute("aria-label", `${tooltip} Change view.`);

  const badge = root.querySelector(".quietest-toggle__badge");
  const badgeText = hidden > 0 ? String(hidden) : "";
  if (badge.textContent !== badgeText) {
    badge.textContent = badgeText;
  }

  for (const item of root.querySelectorAll(".quietest-toggle__item")) {
    const entry = MODES.find((candidate) => candidate.id === item.dataset.mode);
    item.setAttribute("aria-checked", String(entry.id === mode));
    const hint = entry.hides ? `Hides ${pluralFiles(counts[entry.hides], entry.hides)}` : "Hides nothing";
    const hintEl = item.querySelector(".quietest-toggle__hint");
    if (hintEl.textContent !== hint) {
      hintEl.textContent = hint;
    }
  }
}

function stopAfterExtensionUpdate() {
  observer.disconnect();
  applyMarks(TEST_ATTR, new Set());
  applyMarks(IMPL_ATTR, new Set());
  document.getElementById(TOGGLE_ID)?.remove();
}

function markFiles(paths, elementsFor, treeItems) {
  const marked = new Set();
  let count = 0;
  for (const path of paths) {
    const elements = elementsFor(path, hashByPath.get(path), treeItems);
    for (const el of elements) {
      marked.add(el);
    }
    if (elements.length > 0) {
      count += 1;
    }
  }
  addEmptyDirectories(marked);
  return { marked, count };
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
  const paths = candidatePaths(diffLinks());
  const unhashedPaths = paths.filter((path) => !hashByPath.has(path));
  if (unhashedPaths.length > 0) {
    const hashes = await Promise.all(unhashedPaths.map(sha256Hex));
    if (generation !== scanGeneration) {
      return;
    }
    unhashedPaths.forEach((path, index) => hashByPath.set(path, hashes[index]));
  }

  const treeItems = treeItemsByHash(diffLinks());
  const tests = markFiles(paths.filter(isHiddenPath), testElements, treeItems);
  const implementation = markFiles(
    paths.filter((path) => !isHiddenPath(path)),
    implementationElements,
    treeItems,
  );
  applyMarks(TEST_ATTR, tests.marked);
  applyMarks(IMPL_ATTR, implementation.marked);
  counts = { test: tests.count, implementation: implementation.count };
  renderToggle();
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
