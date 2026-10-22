const builtInList = document.getElementById("built-in-rules");
const customList = document.getElementById("custom-rules");
const addForm = document.getElementById("add-rule");
const patternInput = document.getElementById("new-pattern");
const addError = document.getElementById("add-error");
const testInput = document.getElementById("test-path");
const testResult = document.getElementById("test-result");
const resetButton = document.getElementById("reset");

let settings = null;
const openRuleIds = new Set();

function ruleDetails(id, title, example, code) {
  const details = document.createElement("details");
  details.className = "rule-details";
  details.open = openRuleIds.has(id);
  details.addEventListener("toggle", () => {
    if (details.open) {
      openRuleIds.add(id);
    } else {
      openRuleIds.delete(id);
    }
  });
  const summary = document.createElement("summary");
  const text = document.createElement("span");
  text.className = "rule-text";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("small");
  small.textContent = example;
  text.append(strong, small);
  summary.append(text);
  details.append(summary, code);
  return details;
}

function ruleItem({ id, enabled, title, example, pattern, onToggle, onDelete }) {
  const item = document.createElement("li");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = enabled;
  checkbox.setAttribute("aria-label", title ?? pattern);
  checkbox.addEventListener("change", () => onToggle(checkbox.checked));
  const code = document.createElement("code");
  code.textContent = pattern;
  if (title) {
    item.append(checkbox, ruleDetails(id, title, example, code));
  } else {
    const label = document.createElement("label");
    label.append(checkbox, code);
    item.append(label);
  }
  if (onDelete) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary small";
    remove.textContent = "Delete";
    remove.addEventListener("click", onDelete);
    item.append(remove);
  }
  return item;
}

async function save(next) {
  settings = next;
  await chrome.storage.sync.set(next);
  render();
}

function renderTestResult() {
  const path = testInput.value.trim();
  if (!path) {
    testResult.textContent = "";
    return;
  }
  const rule = matchingRule(path, activeRules(settings));
  testResult.dataset.hidden = String(Boolean(rule));
  if (!rule) {
    testResult.textContent = "Shown. No enabled rule matches this path.";
    return;
  }
  testResult.textContent = `Hidden by ${rule.label ?? `your rule "${rule.pattern}"`}.`;
}

function render() {
  resetButton.disabled = settings.disabledRuleIds.length === 0;
  builtInList.replaceChildren(
    ...BUILT_IN_RULES.map((rule) =>
      ruleItem({
        id: rule.id,
        enabled: !settings.disabledRuleIds.includes(rule.id),
        title: rule.label,
        example: rule.flags.includes("i") ? rule.example : `${rule.example} (case-sensitive)`,
        pattern: rule.pattern,
        onToggle: (enabled) => {
          const others = settings.disabledRuleIds.filter((id) => id !== rule.id);
          save({ ...settings, disabledRuleIds: enabled ? others : [...others, rule.id] });
        },
      }),
    ),
  );

  customList.replaceChildren(
    ...settings.customRules.map((rule) =>
      ruleItem({
        enabled: rule.enabled,
        pattern: rule.pattern,
        onToggle: (enabled) => {
          const customRules = settings.customRules.map((other) => (other.id === rule.id ? { ...other, enabled } : other));
          save({ ...settings, customRules });
        },
        onDelete: () => {
          save({ ...settings, customRules: settings.customRules.filter((other) => other.id !== rule.id) });
        },
      }),
    ),
  );
  customList.hidden = settings.customRules.length === 0;

  renderTestResult();
}

addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const pattern = patternInput.value.trim();
  if (!pattern) {
    return;
  }
  try {
    new RegExp(pattern, CUSTOM_RULE_FLAGS);
  } catch (error) {
    addError.textContent = error.message;
    addError.hidden = false;
    return;
  }
  if (settings.customRules.some((rule) => rule.pattern === pattern)) {
    addError.textContent = "This rule already exists.";
    addError.hidden = false;
    return;
  }
  addError.hidden = true;
  aiStatus.textContent = "";
  patternInput.value = "";
  save({ ...settings, customRules: [...settings.customRules, { id: crypto.randomUUID(), pattern, enabled: true }] });
});

patternInput.addEventListener("input", () => {
  addError.hidden = true;
});

testInput.addEventListener("input", renderTestResult);

resetButton.addEventListener("click", () => {
  save({ ...settings, disabledRuleIds: [] });
});

const aiForm = document.getElementById("ai-form");
const aiDescription = document.getElementById("ai-description");
const aiSubmit = document.getElementById("ai-submit");
const aiStatus = document.getElementById("ai-status");
const aiDownload = document.getElementById("ai-download");
const aiDownloadButton = document.getElementById("ai-download-button");
const aiAbout = document.getElementById("ai-about");
const aiUnsupported = document.getElementById("ai-unsupported");
const aiUnsupportedReason = document.getElementById("ai-unsupported-reason");

const AI_LANGUAGES = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};
const AI_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    explanation: { type: "string" },
    examples: { type: "array", items: { type: "string" } },
  },
  required: ["pattern", "explanation", "examples"],
};
const AI_PROMPTS = [
  {
    role: "system",
    content:
      "You turn a plain-English description of files into one JavaScript regular expression. " +
      "The regex is tested with the i flag against full file paths from a GitHub pull request, like src/components/Button.test.tsx. " +
      "Paths use forward slashes and have no leading slash. Return only the pattern source, without slashes or flags. " +
      "Match folders with (^|/)name/ and file endings with $. Keep the regex as simple as possible. " +
      "Also give a one-sentence explanation and 2 or 3 example paths that the regex must match.",
  },
  { role: "user", content: "Storybook stories" },
  {
    role: "assistant",
    content: JSON.stringify({
      pattern: String.raw`\.stories\.[jt]sx?$`,
      explanation: "Files ending in .stories.js, .jsx, .ts, or .tsx.",
      examples: ["src/Button.stories.tsx", "ui/Card.stories.js"],
    }),
  },
  { role: "user", content: "anything in a docs folder" },
  {
    role: "assistant",
    content: JSON.stringify({
      pattern: "(^|/)docs/",
      explanation: "Every file inside a folder named docs, at any depth.",
      examples: ["docs/intro.md", "packages/api/docs/setup.md"],
    }),
  },
];

let aiSession = null;

function createAiSession(monitor) {
  return LanguageModel.create({ ...AI_LANGUAGES, initialPrompts: AI_PROMPTS, monitor });
}

function showDownloadProgress(monitor) {
  monitor.addEventListener("downloadprogress", (event) => {
    if (event.loaded < 1) {
      aiStatus.textContent = `Downloading Chrome's AI model: ${Math.round(event.loaded * 100)}%`;
      return;
    }
    aiStatus.textContent = "Download complete. Preparing the model...";
  });
}

async function suggestRule(description) {
  aiSession ??= await createAiSession();
  const session = await aiSession.clone();
  try {
    return JSON.parse(await session.prompt(description, { responseConstraint: AI_SCHEMA }));
  } finally {
    session.destroy();
  }
}

function setAiBusy(busy) {
  aiForm.setAttribute("aria-busy", String(busy));
  aiDescription.disabled = busy;
  aiSubmit.disabled = busy;
}

aiForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const description = aiDescription.value.trim();
  if (!description) {
    return;
  }
  setAiBusy(true);
  aiStatus.textContent = "Generating a regex you won't regret...";
  try {
    const suggestion = await suggestRule(description);
    const regex = new RegExp(suggestion.pattern, CUSTOM_RULE_FLAGS);
    const misses = suggestion.examples.filter((example) => !regex.test(example));
    patternInput.value = suggestion.pattern;
    addError.hidden = true;
    patternInput.focus();
    if (misses.length > 0) {
      aiStatus.textContent = `${suggestion.explanation} Check it before you add it: it does not match ${misses.join(", ")}.`;
    } else {
      aiStatus.textContent = `${suggestion.explanation} Review it, then click Add rule.`;
    }
  } catch (error) {
    aiStatus.textContent = `Could not write a regex: ${error.message}`;
  } finally {
    setAiBusy(false);
  }
});

function showAiForm() {
  aiDownload.hidden = true;
  aiAbout.hidden = false;
  aiForm.hidden = false;
}

aiDownloadButton.addEventListener("click", async () => {
  aiDownloadButton.disabled = true;
  aiStatus.textContent = "Starting the download...";
  try {
    aiSession = await createAiSession(showDownloadProgress);
    showAiForm();
    aiStatus.textContent = "Chrome's AI model is ready. Describe the files to hide.";
    aiDescription.focus();
  } catch (error) {
    aiStatus.textContent = `Could not download the model: ${error.message}`;
  } finally {
    aiDownloadButton.disabled = false;
  }
});

function showAiUnsupported(reason) {
  aiUnsupportedReason.textContent = `${reason} You can still write a regex yourself below.`;
  aiUnsupported.hidden = false;
}

async function setUpAi() {
  if (!("LanguageModel" in self)) {
    showAiUnsupported("Your Chrome version does not support built-in AI. Update Chrome to the latest version, then reload this page.");
    return;
  }
  const availability = await LanguageModel.availability(AI_LANGUAGES).catch(() => "unavailable");
  if (availability === "unavailable") {
    showAiUnsupported(
      "Chrome's built-in AI is not available on this computer. It needs at least 22 GB of free disk space, and a GPU with more than 4 GB of memory or 16 GB of RAM. It can also be turned off in Chrome's settings or by your organization.",
    );
    return;
  }
  if (availability === "available") {
    showAiForm();
    return;
  }
  aiDownload.hidden = false;
}

setUpAi();

loadSettings().then((loaded) => {
  settings = loaded;
  render();
});
