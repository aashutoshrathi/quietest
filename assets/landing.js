const viewButtons = document.querySelectorAll("[data-view]");
const demoFiles = document.querySelectorAll("[data-file-kind]");
const implementationCode = document.getElementById("implementation-code");
const testsCode = document.getElementById("tests-code");
const fileCount = document.getElementById("file-count");
const addedCount = document.getElementById("added-count");
const removedCount = document.getElementById("removed-count");
const hiddenSummary = document.getElementById("hidden-summary");
const demoStatus = document.getElementById("demo-status");

for (const button of viewButtons) {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    let visibleCount = 0;

    for (const file of demoFiles) {
      file.hidden = view !== "both" && file.dataset.fileKind !== view;
      if (!file.hidden) {
        visibleCount += 1;
      }
    }

    for (const viewButton of viewButtons) {
      viewButton.setAttribute("aria-pressed", String(viewButton === button));
    }

    implementationCode.hidden = view === "tests";
    testsCode.hidden = view === "implementation";
    document.querySelector(".demo-body").scrollTop = 0;
    fileCount.textContent = visibleCount;
    hiddenSummary.hidden = view === "both";

    if (view === "implementation") {
      addedCount.textContent = "+42";
      removedCount.textContent = "−18";
      hiddenSummary.textContent = "✓ 4 test & mock files muted";
      demoStatus.textContent = "Showing 2 implementation files. 4 test and mock files hidden.";
    } else if (view === "tests") {
      addedCount.textContent = "+382";
      removedCount.textContent = "−0";
      hiddenSummary.textContent = "✓ 2 implementation files muted";
      demoStatus.textContent = "Showing 4 test and mock files. 2 implementation files hidden.";
    } else {
      addedCount.textContent = "+424";
      removedCount.textContent = "−18";
      demoStatus.textContent = "Showing all 6 files. Nothing hidden.";
    }
  });
}

function revealInstallGuide() {
  if (window.location.hash === "#manual-install") {
    document.getElementById("manual-install").open = true;
  }
}

window.addEventListener("hashchange", revealInstallGuide);
revealInstallGuide();

for (const link of document.querySelectorAll('a[href="#manual-install"]')) {
  link.addEventListener("click", () => {
    document.getElementById("manual-install").open = true;
  });
}

const copyAddress = document.querySelector(".copy-address");
const copyStatus = document.getElementById("copy-status");

copyAddress.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById("extensions-address").textContent);
    copyAddress.textContent = "Copied!";
    copyStatus.textContent = "Address copied. Paste it into a new tab.";
  } catch {
    copyAddress.textContent = "Copy address";
    copyStatus.textContent = "Select and copy chrome://extensions/ above.";
  }
});
