const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/truediff.js"), "utf8");
const { parseUnifiedDiff, trueDiffFile, tokenize, myersMatches, diffUrlFor } = vm.runInNewContext(
  `${source}; ({ parseUnifiedDiff, trueDiffFile, tokenize, myersMatches, diffUrlFor })`,
);

const plain = (value) => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) => assert.deepEqual(plain(actual), expected, message);

const diffOf = (body, header = "diff --git a/src/app.js b/src/app.js\nindex 1..2 100644\n--- a/src/app.js\n+++ b/src/app.js\n") =>
  trueDiffFile(parseUnifiedDiff(header + body)[0]);

const changedTexts = (file, side) =>
  file.hunks.flatMap((hunk) =>
    hunk.rows.flatMap((row) => (row[side] ? row[side].tokens.filter((t) => t.changed).map((t) => t.text) : [])),
  );

test("tokenizes words, strings, and punctuation, skipping whitespace", () => {
  same(
    tokenize(`  const a = "x y";`).map((t) => t.text),
    ["const", "a", "=", '"x y"', ";"],
  );
  same(tokenize("  foo")[0], { text: "foo", start: 2, end: 5 });
});

test("myers matches the longest common subsequence", () => {
  const matches = myersMatches(["a", "b", "c", "d"], ["a", "c", "x", "d"], 10);
  same(matches, [[0, 0], [2, 1], [3, 3]]);
  same(myersMatches([], [], 0), []);
  assert.equal(myersMatches(["a", "b"], ["c", "d"], 1), null);
});

test("parses file headers, statuses, and line numbers", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/old.js b/new.js",
      "similarity index 90%",
      "rename from old.js",
      "rename to new.js",
      "--- a/old.js",
      "+++ b/new.js",
      "@@ -10,2 +10,2 @@ function f() {",
      " keep",
      "-gone",
      "+here",
      "\\ No newline at end of file",
      "diff --git a/added.txt b/added.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.txt",
      "@@ -0,0 +1 @@",
      "+hi",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n"),
  );
  assert.equal(files.length, 3);
  same([files[0].oldPath, files[0].newPath, files[0].status], ["old.js", "new.js", "renamed"]);
  same(
    files[0].hunks[0].lines.map((l) => [l.kind, l.oldNumber, l.newNumber, l.text]),
    [
      ["context", 10, 10, "keep"],
      ["removed", 11, null, "gone"],
      ["added", null, 11, "here"],
    ],
  );
  assert.equal(files[1].status, "added");
  assert.equal(files[2].binary, true);
});

test("reindenting and rewrapping code is formatting only", () => {
  const file = diffOf(
    [
      "@@ -1,3 +1,5 @@",
      "-if (ready) { run(a, b); }",
      "+if (ready) {",
      "+    run(a,",
      "+        b);",
      "+}",
      " done();",
      "",
    ].join("\n"),
  );
  assert.equal(file.githubChangedLines, 5);
  assert.equal(file.realChangedLines, 0);
  assert.equal(file.changedTokens, 0);
  assert.equal(file.formattingOnly, true);
});

test("highlights only the tokens that really changed", () => {
  const file = diffOf(["@@ -1 +1 @@", "-const total = price * qty;", "+const total = price * quantity + tax;", ""].join("\n"));
  same(changedTexts(file, "old"), ["qty"]);
  same(changedTexts(file, "new"), ["quantity", "+", "tax"]);
  assert.equal(file.formattingOnly, false);
  assert.equal(file.realChangedLines, 2);
  const [row] = file.hunks[0].rows;
  assert.equal(row.old.number, 1);
  assert.equal(row.new.number, 1);
});

test("aligns matching lines side by side and leaves inserted lines alone", () => {
  const file = diffOf(
    ["@@ -1,2 +1,3 @@", " a();", "+b();", " c();", ""].join("\n"),
  );
  const rows = file.hunks[0].rows.map((row) => [row.old?.text ?? null, row.new?.text ?? null]);
  same(rows, [
    ["a();", "a();"],
    [null, "b();"],
    ["c();", "c();"],
  ]);
});

test("added and deleted files are never formatting only", () => {
  const file = diffOf(
    "@@ -0,0 +1 @@\n+x\n",
    "diff --git a/n.js b/n.js\nnew file mode 100644\n--- /dev/null\n+++ b/n.js\n",
  );
  assert.equal(file.status, "added");
  assert.equal(file.formattingOnly, false);
  same(changedTexts(file, "new"), ["x"]);
});

test("builds .diff URLs for PRs and for commits inside a PR", () => {
  assert.equal(diffUrlFor("/o/r/pull/12/files"), "https://github.com/o/r/pull/12.diff");
  assert.equal(diffUrlFor("/o/r/pull/12/changes"), "https://github.com/o/r/pull/12.diff");
  assert.equal(diffUrlFor("/o/r/pull/12/commits/abcdef1234"), "https://github.com/o/r/commit/abcdef1234.diff");
  assert.equal(diffUrlFor("/o/r/issues/3"), null);
});

test("diffs this repository's own history without throwing", () => {
  const { execFileSync } = require("node:child_process");
  let text;
  try {
    text = execFileSync("git", ["log", "-p", "-n", "15", "--format="], { cwd: path.join(__dirname, ".."), maxBuffer: 1 << 26 }).toString();
  } catch {
    return;
  }
  for (const file of parseUnifiedDiff(text)) {
    const result = trueDiffFile(file);
    assert.ok(result.realChangedLines <= result.githubChangedLines, file.newPath);
  }
});

test("blank lines are neither real nor formatting-only changes", () => {
  const file = diffOf(["@@ -1 +1,3 @@", " a();", "+", "+b();", ""].join("\n"));
  assert.equal(file.realChangedLines, 1);
  assert.equal(file.formattingLines, 0);
  assert.equal(file.githubChangedLines, 2);
});
