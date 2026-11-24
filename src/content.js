const TEST_ATTR = "data-quietest-test";
const IMPL_ATTR = "data-quietest-impl";
const MUTED_ATTR = "data-quietest-muted";
const FORMATTING_ATTR = "data-quietest-formatting-only";
const REVIEW_PATH = /^(\/[^/]+\/[^/]+\/pull\/\d+)\/(files|changes|commits\/)/;
const DIFF_HREF = /#diff-([0-9a-f]{64})$/;
const TOGGLE_ID = "quietest-toggle";
const TRUE_DIFF_ID = "quietest-truediff";
const LAZY_ROWS = 600;
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
let excludedRepos = [];
let counts = { test: 0, implementation: 0 };
let diffCache = null;
let muteFormatting = false;
let muteDefault;
let muteData = null;
let introSeen;

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
    closeTrueDiff();
    diffCache = null;
    muteFormatting = muteDefault;
    muteData = null;
    setMode(DEFAULT_MODE);
  }
  return key;
}

function isExcludedRepo() {
  const repo = location.pathname.split("/").slice(1, 3).join("/").toLowerCase();
  return excludedRepos.includes(repo);
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
      <div class="quietest-toggle__separator" role="separator"></div>
      <button type="button" role="menuitem" class="quietest-toggle__item quietest-toggle__action" data-action="true-diff">
        <span class="quietest-toggle__check" aria-hidden="true">&#x2260;</span>
        <span class="quietest-toggle__label">Open true diff</span>
        <span class="quietest-toggle__hint">Mutes formatting-only changes</span>
      </button>
      <button type="button" role="menuitemcheckbox" class="quietest-toggle__item" data-action="mute-formatting" aria-checked="false">
        <span class="quietest-toggle__check" aria-hidden="true"></span>
        <span class="quietest-toggle__label">Mute formatting changes</span>
        <span class="quietest-toggle__hint"></span>
      </button>
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
  root.querySelector('[data-action="true-diff"]').addEventListener("click", () => {
    setMenuOpen(root, false);
    openTrueDiff();
  });
  root.querySelector('[data-action="mute-formatting"]').addEventListener("click", () => {
    setMuteFormatting(!muteFormatting);
  });
  for (const item of root.querySelectorAll(".quietest-toggle__item[data-mode]")) {
    item.addEventListener("click", () => {
      setMode(item.dataset.mode);
      setMenuOpen(root, false);
      renderToggle();
      if (document.getElementById(TRUE_DIFF_ID)) {
        openTrueDiff({ reuse: true });
      }
      root.querySelector(".quietest-toggle__button").focus();
    });
  }
  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) {
      setMenuOpen(root, false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.getElementById(TRUE_DIFF_ID)) {
      closeTrueDiff();
      root.querySelector(".quietest-toggle__button").focus();
    } else if (event.key === "Escape" && root.classList.contains("quietest-toggle--open")) {
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

  for (const item of root.querySelectorAll(".quietest-toggle__item[data-mode]")) {
    const entry = MODES.find((candidate) => candidate.id === item.dataset.mode);
    item.setAttribute("aria-checked", String(entry.id === mode));
    const hint = entry.hides ? `Hides ${pluralFiles(counts[entry.hides], entry.hides)}` : "Hides nothing";
    const hintEl = item.querySelector(".quietest-toggle__hint");
    if (hintEl.textContent !== hint) {
      hintEl.textContent = hint;
    }
  }

  renderMuteItem(root);
  renderIntro(root);
}

// ---- True diff viewer ----

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function fetchDiff(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "quietest:fetch-diff", url }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response?.ok) {
        reject(new Error(response?.error || "Could not load the diff"));
      } else {
        resolve(response.text);
      }
    });
  });
}

function isTestFile(file) {
  return [file.newPath, file.oldPath].some((path) => path && path.length <= MAX_PATH_LENGTH && isHiddenPath(path));
}

function filesForMode(files, mode) {
  if (mode === "implementation") {
    return files.filter((file) => !isTestFile(file));
  }
  if (mode === "tests") {
    return files.filter(isTestFile);
  }
  return files;
}

function closeTrueDiff() {
  const panel = document.getElementById(TRUE_DIFF_ID);
  if (panel) {
    panel.remove();
    document.documentElement.classList.remove("quietest-truediff-open");
  }
}

function renderCode(line, side) {
  const code = el("td", "qtd-code");
  if (!line) {
    code.classList.add("qtd-empty");
    return code;
  }
  let position = 0;
  for (const token of line.tokens) {
    if (token.start > position) {
      code.append(line.text.slice(position, token.start));
    }
    if (token.changed) {
      code.append(el("span", side === "old" ? "qtd-tok-del" : "qtd-tok-add", token.text));
    } else {
      code.append(token.text);
    }
    position = token.end;
  }
  code.append(line.text.slice(position));
  if (line.githubChanged) {
    const real = line.tokens.some((token) => token.changed);
    code.classList.add(real ? (side === "old" ? "qtd-del" : "qtd-add") : "qtd-quiet");
    if (!real) {
      code.title = "GitHub marks this line changed, but only whitespace or line breaks moved.";
    }
  }
  return code;
}

function renderNumber(line) {
  return el("td", "qtd-num", line ? String(line.number) : "");
}

function renderFileBody(file) {
  if (file.binary) {
    return el("p", "qtd-note", "Binary file. Nothing to compare.");
  }
  if (file.hunks.length === 0) {
    return el("p", "qtd-note", file.status === "renamed" ? "Renamed without changes." : "No text changes.");
  }
  const table = el("table", "qtd-table");
  const columns = el("colgroup");
  for (const className of ["qtd-col-num", "qtd-col-code", "qtd-col-num", "qtd-col-code"]) {
    columns.append(el("col", className));
  }
  table.append(columns);
  const body = el("tbody");
  for (const hunk of file.hunks) {
    const headerRow = el("tr", "qtd-hunk");
    const headerCell = el("td", "", hunk.exact ? hunk.header : `${hunk.header}  (too large for a token diff, showing GitHub's line diff)`);
    headerCell.colSpan = 4;
    headerRow.append(headerCell);
    body.append(headerRow);
    for (const row of hunk.rows) {
      const tr = el("tr");
      tr.append(renderNumber(row.old), renderCode(row.old, "old"), renderNumber(row.new), renderCode(row.new, "new"));
      body.append(tr);
    }
  }
  table.append(body);
  return table;
}

function rowCount(file) {
  return file.hunks.reduce((sum, hunk) => sum + hunk.rows.length + 1, 0);
}

function fileTitle(file) {
  if (file.status === "renamed" && file.oldPath !== file.newPath) {
    return `${file.oldPath} → ${file.newPath}`;
  }
  return file.status === "deleted" ? file.oldPath : file.newPath;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function fileStat(file) {
  if (file.formattingOnly) {
    return `Formatting only · ${plural(file.githubChangedLines, "line")} GitHub marks changed`;
  }
  const labels = { added: "Added", deleted: "Deleted", renamed: "Renamed" };
  const prefix = labels[file.status] ? `${labels[file.status]} · ` : "";
  if (file.githubChangedLines === 0) {
    return prefix.slice(0, -3);
  }
  const muted = file.formattingLines > 0 ? ` · ${plural(file.formattingLines, "formatting-only line")} muted` : "";
  return `${prefix}${plural(file.realChangedLines, "changed line")}${muted}`;
}

function renderFile(file) {
  const details = el("details", "qtd-file");
  details.dataset.formattingOnly = String(file.formattingOnly);
  const summary = el("summary", "qtd-file__header");
  const link = el("a", "qtd-file__path", fileTitle(file));
  link.href = "#";
  link.title = "Jump to this file in GitHub's diff";
  link.addEventListener("click", async (event) => {
    event.preventDefault();
    const hash = await sha256Hex(file.status === "deleted" ? file.oldPath : file.newPath);
    closeTrueDiff();
    location.hash = `diff-${hash}`;
  });
  summary.append(link, el("span", "qtd-file__stat", fileStat(file)));
  details.append(summary);

  const lazy = file.formattingOnly || rowCount(file) > LAZY_ROWS;
  if (lazy) {
    details.addEventListener(
      "toggle",
      () => details.append(renderFileBody(file)),
      { once: true },
    );
  } else {
    details.open = true;
    details.append(renderFileBody(file));
  }
  return details;
}

function modeSummary(mode, allFiles, shownFiles) {
  const skipped = allFiles.length - shownFiles.length;
  const hides = MODES.find((entry) => entry.id === mode).hides;
  return hides && skipped > 0 ? `${pluralFiles(skipped, hides)} hidden by this view` : "";
}

function createTrueDiffPanel() {
  const panel = el("div");
  panel.id = TRUE_DIFF_ID;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Quietest true diff");

  const bar = el("div", "qtd-bar");
  const title = el("div", "qtd-bar__title");
  title.append(el("strong", "", "True diff"), el("span", "qtd-bar__summary", "Loading…"));
  const quietLabel = el("label", "qtd-bar__option");
  const quietBox = el("input");
  quietBox.type = "checkbox";
  quietBox.checked = true;
  quietBox.addEventListener("change", () => panel.classList.toggle("qtd--show-formatting", !quietBox.checked));
  quietLabel.append(quietBox, " Hide formatting-only files");
  const close = el("button", "qtd-bar__close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close true diff");
  close.addEventListener("click", closeTrueDiff);
  bar.append(title, quietLabel, close);

  panel.append(bar, el("div", "qtd-files"));
  return panel;
}

async function openTrueDiff({ reuse = false } = {}) {
  closeTrueDiff();
  const url = diffUrlFor(location.pathname);
  if (!url) {
    return;
  }
  const mode = currentMode();
  const panel = createTrueDiffPanel();
  document.body.append(panel);
  document.documentElement.classList.add("quietest-truediff-open");
  panel.querySelector(".qtd-bar__close").focus();
  const summary = panel.querySelector(".qtd-bar__summary");
  const list = panel.querySelector(".qtd-files");

  let text;
  try {
    text = reuse && diffCache?.url === url ? diffCache.text : await fetchDiff(url);
    diffCache = { url, text };
  } catch (error) {
    summary.textContent = `Could not load this diff from GitHub: ${error.message}`;
    return;
  }
  if (!panel.isConnected) {
    return;
  }

  const allFiles = parseUnifiedDiff(text);
  const shown = filesForMode(allFiles, mode);
  const diffed = [];
  for (const [index, file] of shown.entries()) {
    const result = trueDiffFile(file);
    diffed.push(result);
    list.append(renderFile(result));
    if (index % 5 === 4) {
      await new Promise((resolve) => setTimeout(resolve));
      if (!panel.isConnected) {
        return;
      }
    }
  }

  const formattingOnly = diffed.filter((file) => file.formattingOnly).length;
  const githubLines = diffed.reduce((sum, file) => sum + file.githubChangedLines, 0);
  const realLines = diffed.reduce((sum, file) => sum + file.realChangedLines, 0);
  const parts = [
    diffed.length === 1 ? "1 file" : `${diffed.length} files`,
    `${realLines} of ${plural(githubLines, "changed line")} ${realLines === 1 ? "is a real change" : "are real changes"}`,
  ];
  if (formattingOnly > 0) {
    parts.push(`${pluralFiles(formattingOnly, "formatting-only")}`);
  }
  const hidden = modeSummary(mode, allFiles, shown);
  if (hidden) {
    parts.push(hidden);
  }
  summary.textContent = parts.join(" · ");
  if (diffed.length === 0) {
    list.append(el("p", "qtd-note", "No files to show in this view."));
  }
}

function setMuteFormatting(on) {
  muteFormatting = on;
  renderToggle();
  queueScan();
}

function muteHint() {
  if (!muteFormatting || !muteData) {
    return "Greys lines that only move whitespace";
  }
  if (muteData.loading) {
    return "Loading the diff…";
  }
  if (muteData.error) {
    return muteData.error;
  }
  return `${plural(muteData.lineCount, "line")} muted`;
}

function renderMuteItem(root) {
  const item = root.querySelector('[data-action="mute-formatting"]');
  item.setAttribute("aria-checked", String(muteFormatting));
  const hint = muteHint();
  const hintEl = item.querySelector(".quietest-toggle__hint");
  if (hintEl.textContent !== hint) {
    hintEl.textContent = hint;
  }
}

function createIntro() {
  const turnOn = el("button", "quietest-intro__button quietest-intro__button--primary", "Turn on");
  turnOn.type = "button";
  turnOn.addEventListener("click", () => {
    introSeen = true;
    chrome.storage.sync.set({ muteFormattingByDefault: true, trueDiffIntroSeen: true });
    setMuteFormatting(true);
  });
  const dismiss = el("button", "quietest-intro__button", "Not now");
  dismiss.type = "button";
  dismiss.addEventListener("click", () => {
    introSeen = true;
    chrome.storage.sync.set({ trueDiffIntroSeen: true });
    renderToggle();
  });
  const actions = el("div", "quietest-intro__actions");
  actions.append(turnOn, dismiss);

  const intro = el("div", "quietest-intro");
  intro.setAttribute("role", "dialog");
  intro.setAttribute("aria-label", "New True Diff View");
  intro.setAttribute("data-testid", "quietest-intro");
  intro.append(
    el("strong", "quietest-intro__title", "New: True Diff View by Quietest"),
    el(
      "p",
      "quietest-intro__text",
      "Grey out lines that only move whitespace or line breaks, right in this diff. Open true diff in this menu shows a side-by-side view. You can change this in Quietest's settings.",
    ),
    actions,
  );
  return intro;
}

function renderIntro(root) {
  const intro = root.querySelector(".quietest-intro");
  const wanted = !introSeen && !muteDefault;
  if (wanted && !intro) {
    root.querySelector(".quietest-toggle__button").before(createIntro());
  } else if (!wanted && intro) {
    intro.remove();
  }
}

async function computeMuteData(url) {
  const text = diffCache?.url === url ? diffCache.text : await fetchDiff(url);
  diffCache = { url, text };
  const files = parseUnifiedDiff(text);
  const hashes = await Promise.all(
    files.map((file) => sha256Hex(file.status === "deleted" ? file.oldPath : file.newPath)),
  );
  const anchors = new Set();
  const formattingOnlyHashes = new Set();
  for (const [index, file] of files.entries()) {
    if (diffUrlFor(location.pathname) !== url) {
      return null;
    }
    const diffed = trueDiffFile(file);
    for (const anchor of mutedLineAnchors(diffed, hashes[index])) {
      anchors.add(anchor);
    }
    if (diffed.formattingOnly) {
      formattingOnlyHashes.add(hashes[index]);
    }
    if (index % 5 === 4) {
      await new Promise((resolve) => setTimeout(resolve));
    }
  }
  return { url, anchors, formattingOnlyHashes, lineCount: anchors.size };
}

async function loadMuteData(url) {
  if (muteData?.url === url) {
    return;
  }
  const pending = { url, loading: true };
  muteData = pending;
  renderToggle();
  let result;
  try {
    result = await computeMuteData(url);
  } catch (error) {
    result = { url, error: error.message };
  }
  if (muteData !== pending) {
    return;
  }
  muteData = result && diffUrlFor(location.pathname) === url ? result : null;
  renderToggle();
  queueScan();
}

function clearMutes() {
  applyMarks(MUTED_ATTR, new Set());
  applyMarks(FORMATTING_ATTR, new Set());
}

function newUiMutedTargets(anchors) {
  const targets = new Set();
  for (const cell of document.querySelectorAll("[data-line-anchor]")) {
    if (!anchors.has(cell.dataset.lineAnchor)) {
      continue;
    }
    const row = cell.closest("tr");
    if (row.querySelectorAll('[data-diff-cell="text"]').length === 1) {
      targets.add(row);
    } else {
      for (const sibling of row.children) {
        if (sibling.dataset.diffSide === cell.dataset.diffSide) {
          targets.add(sibling);
        }
      }
    }
  }
  return targets;
}

function classicMutedTargets(anchors) {
  const targets = new Set();
  for (const cell of document.querySelectorAll('td.blob-num[id^="diff-"]')) {
    if (!anchors.has(cell.id)) {
      continue;
    }
    const row = cell.closest("tr");
    if (row.querySelectorAll(".blob-code").length === 1) {
      targets.add(row);
    } else {
      targets.add(cell);
      targets.add(cell.nextElementSibling);
    }
  }
  return targets;
}

function formattingOnlyLabels(hashes) {
  const labels = new Set();
  for (const hash of hashes) {
    const file = document.getElementById(`diff-${hash}`);
    const labelId = file?.getAttribute("aria-labelledby");
    const label = labelId ? document.getElementById(labelId)?.parentElement : file?.querySelector(".file-header .file-info");
    if (label) {
      labels.add(label);
    }
  }
  return labels;
}

function applyMutes() {
  if (!muteFormatting || !muteData?.anchors) {
    clearMutes();
    return;
  }
  applyMarks(MUTED_ATTR, new Set([...newUiMutedTargets(muteData.anchors), ...classicMutedTargets(muteData.anchors)]));
  applyMarks(FORMATTING_ATTR, formattingOnlyLabels(muteData.formattingOnlyHashes));
}

function clearPage() {
  applyMarks(TEST_ATTR, new Set());
  applyMarks(IMPL_ATTR, new Set());
  clearMutes();
  closeTrueDiff();
  document.getElementById(TOGGLE_ID)?.remove();
}

function stopAfterExtensionUpdate() {
  observer.disconnect();
  clearPage();
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
    closeTrueDiff();
    clearMutes();
    document.getElementById(TOGGLE_ID)?.remove();
    return;
  }
  if (isExcludedRepo()) {
    clearPage();
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
  if (muteFormatting) {
    loadMuteData(diffUrlFor(location.pathname));
  }
  applyMutes();
}

function queueScan() {
  if (scanQueued) {
    return;
  }
  scanQueued = true;
  setTimeout(scan, 150);
}

async function refreshRules() {
  const settings = await loadSettings();
  const stored = await chrome.storage.sync.get("trueDiffIntroSeen");
  hideRules = activeRules(settings);
  excludedRepos = settings.excludedRepos;
  muteDefault = settings.muteFormattingByDefault;
  introSeen = stored.trueDiffIntroSeen === true;
  hiddenByPath.clear();
  scanGeneration += 1;
  queueScan();
}

const observer = new MutationObserver(queueScan);
chrome.storage.onChanged.addListener(refreshRules);
observer.observe(document.documentElement, { childList: true, subtree: true });
refreshRules();
