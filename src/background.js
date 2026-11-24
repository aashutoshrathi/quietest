chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// GitHub serves a PR's .diff from patch-diff.githubusercontent.com, which a content script
// cannot read across origins. The service worker can, with the user's GitHub session.
const DIFF_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull\/\d+|commit\/[0-9a-f]{7,40})\.diff$/;
// Chrome refuses extension messages over 64 MiB, and bigger diffs take too long to compare.
const MAX_DIFF_MB = 20;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "quietest:fetch-diff" || !DIFF_URL.test(message.url)) {
    return false;
  }
  fetch(message.url, { credentials: "include" })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`GitHub answered ${response.status}`);
      }
      const text = await response.text();
      const megabytes = text.length / (1024 * 1024);
      if (megabytes > MAX_DIFF_MB) {
        throw new Error(`The diff is ${Math.round(megabytes)} MB, over the ${MAX_DIFF_MB} MB limit. Use GitHub's diff for this PR`);
      }
      sendResponse({ ok: true, text });
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
