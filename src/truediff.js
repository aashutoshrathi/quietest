// True diff: a difftastic-style comparison computed in the browser.
// GitHub diffs lines. This diffs tokens, ignoring whitespace and line breaks, so reindenting,
// rewrapping, or reformatting code shows as unchanged and only real edits are highlighted.

// Tokens: string literals, words, numbers, and single punctuation characters. Whitespace is skipped.
const TOKEN = /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?|[\p{L}\p{N}_$]+|\S/gu;
const MAX_TOKENS_PER_SIDE = 20000;
const MAX_EDIT_DISTANCE = 4000;
const DIFF_GIT_HEADER = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function unquoteGitPath(path) {
  return path.startsWith('"') && path.endsWith('"') ? JSON.parse(path) : path;
}

function parsePathLine(line, prefix) {
  const raw = line.slice(4).replace(/\t.*$/, "");
  if (raw === "/dev/null") {
    return null;
  }
  const path = unquoteGitPath(raw);
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// Parses `git diff` output (as served by GitHub's .diff URLs) into files and hunks.
function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of text.split("\n")) {
    const header = line.match(DIFF_GIT_HEADER);
    if (header) {
      file = { oldPath: unquoteGitPath(header[1]), newPath: unquoteGitPath(header[2]), status: "modified", binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) {
      continue;
    }
    const hunkHeader = line.match(HUNK_HEADER);
    if (hunkHeader) {
      oldLine = Number(hunkHeader[1]);
      newLine = Number(hunkHeader[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line.startsWith("--- ")) {
        const path = parsePathLine(line, "a/");
        if (path === null) {
          file.status = "added";
        } else {
          file.oldPath = path;
        }
      } else if (line.startsWith("+++ ")) {
        const path = parsePathLine(line, "b/");
        if (path === null) {
          file.status = "deleted";
        } else {
          file.newPath = path;
        }
      } else if (line.startsWith("new file mode")) {
        file.status = "added";
      } else if (line.startsWith("deleted file mode")) {
        file.status = "deleted";
      } else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) {
        file.newPath = line.slice("rename to ".length);
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
        file.binary = true;
      }
      continue;
    }
    const kind = line[0];
    if (kind === " ") {
      hunk.lines.push({ kind: "context", oldNumber: oldLine++, newNumber: newLine++, text: line.slice(1) });
    } else if (kind === "-") {
      hunk.lines.push({ kind: "removed", oldNumber: oldLine++, newNumber: null, text: line.slice(1) });
    } else if (kind === "+") {
      hunk.lines.push({ kind: "added", oldNumber: null, newNumber: newLine++, text: line.slice(1) });
    } else if (kind === "\\") {
      // "\ No newline at end of file"
    } else if (line === "") {
      // Trailing newline of the whole diff, or an empty context line some tools write without its space.
    } else {
      hunk = null;
    }
  }
  return files;
}

function tokenize(text) {
  return [...text.matchAll(TOKEN)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

// Myers' O(ND) diff. Returns matched index pairs, or null when the sequences differ by more than maxD edits.
function myersMatches(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const offset = maxD + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace = [];
  let found = false;
  for (let d = 0; d <= maxD && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) {
    return null;
  }
  const matches = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const prev = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : prev[offset + prevK];
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  return matches.reverse();
}

// One side of a hunk: the lines that side has, each with its tokens.
function sideLines(hunk, side) {
  const skip = side === "old" ? "added" : "removed";
  return hunk.lines
    .filter((line) => line.kind !== skip)
    .map((line) => ({
      number: side === "old" ? line.oldNumber : line.newNumber,
      text: line.text,
      githubChanged: line.kind !== "context",
      tokens: tokenize(line.text).map((token) => ({ ...token, changed: false })),
      partner: null,
    }));
}

function flatTokens(lines) {
  const flat = [];
  lines.forEach((line, lineIndex) => {
    for (const token of line.tokens) {
      flat.push({ token, lineIndex });
    }
  });
  return flat;
}

// Pairs old and new lines into side-by-side rows, aligned on lines that share matched tokens.
function alignRows(oldLines, newLines) {
  const anchors = [];
  let lastNew = -1;
  oldLines.forEach((line, oldIndex) => {
    if (line.partner !== null && line.partner > lastNew) {
      anchors.push([oldIndex, line.partner]);
      lastNew = line.partner;
    }
  });
  anchors.push([oldLines.length, newLines.length]);

  const rows = [];
  let oldNext = 0;
  let newNext = 0;
  for (const [oldAnchor, newAnchor] of anchors) {
    const gap = Math.max(oldAnchor - oldNext, newAnchor - newNext);
    for (let offset = 0; offset < gap; offset += 1) {
      const oldIndex = oldNext + offset < oldAnchor ? oldNext + offset : null;
      const newIndex = newNext + offset < newAnchor ? newNext + offset : null;
      rows.push({ old: oldIndex === null ? null : oldLines[oldIndex], new: newIndex === null ? null : newLines[newIndex] });
    }
    if (oldAnchor < oldLines.length) {
      rows.push({ old: oldLines[oldAnchor], new: newLines[newAnchor] });
    }
    oldNext = oldAnchor + 1;
    newNext = newAnchor + 1;
  }
  return rows;
}

function lineHasRealChange(line) {
  return line.tokens.some((token) => token.changed);
}

function diffHunk(hunk) {
  const oldLines = sideLines(hunk, "old");
  const newLines = sideLines(hunk, "new");
  const oldFlat = flatTokens(oldLines);
  const newFlat = flatTokens(newLines);

  let matches = null;
  if (oldFlat.length <= MAX_TOKENS_PER_SIDE && newFlat.length <= MAX_TOKENS_PER_SIDE) {
    matches = myersMatches(
      oldFlat.map((entry) => entry.token.text),
      newFlat.map((entry) => entry.token.text),
      MAX_EDIT_DISTANCE,
    );
  }

  if (matches === null) {
    // Too large to diff by token: fall back to GitHub's line diff.
    for (const line of [...oldLines, ...newLines]) {
      for (const token of line.tokens) {
        token.changed = line.githubChanged;
      }
    }
  } else {
    for (const entry of [...oldFlat, ...newFlat]) {
      entry.token.changed = true;
    }
    for (const [oldIndex, newIndex] of matches) {
      const oldEntry = oldFlat[oldIndex];
      const newEntry = newFlat[newIndex];
      oldEntry.token.changed = false;
      newEntry.token.changed = false;
      const oldLine = oldLines[oldEntry.lineIndex];
      if (oldLine.partner === null) {
        oldLine.partner = newEntry.lineIndex;
      }
    }
  }

  const rows = alignRows(oldLines, newLines);
  const githubChangedLines = hunk.lines.filter((line) => line.kind !== "context").length;
  const touched = [...oldLines, ...newLines].filter((line) => line.githubChanged);
  const realChangedLines = touched.filter(lineHasRealChange).length;
  // Blank lines have no tokens, so they count as neither real nor formatting-only changes.
  const formattingLines = touched.filter((line) => line.tokens.length > 0 && !lineHasRealChange(line)).length;
  return { header: hunk.header, rows, githubChangedLines, realChangedLines, formattingLines, exact: matches !== null };
}

function changedTokenCount(hunks) {
  let count = 0;
  for (const hunk of hunks) {
    for (const row of hunk.rows) {
      for (const line of [row.old, row.new]) {
        count += line ? line.tokens.filter((token) => token.changed).length : 0;
      }
    }
  }
  return count;
}

// Diffs one parsed file. A file whose edits are all whitespace or line breaks is "formatting only".
function trueDiffFile(file) {
  const hunks = file.hunks.map(diffHunk);
  const githubChangedLines = hunks.reduce((sum, hunk) => sum + hunk.githubChangedLines, 0);
  const realChangedLines = hunks.reduce((sum, hunk) => sum + hunk.realChangedLines, 0);
  const formattingLines = hunks.reduce((sum, hunk) => sum + hunk.formattingLines, 0);
  const changedTokens = changedTokenCount(hunks);
  const formattingOnly =
    !file.binary && file.status !== "added" && file.status !== "deleted" && githubChangedLines > 0 && changedTokens === 0;
  return { ...file, hunks, githubChangedLines, realChangedLines, formattingLines, changedTokens, formattingOnly };
}

// The .diff URL for a PR review page, or for a single commit inside a PR.
function diffUrlFor(pathname) {
  const commit = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/\d+\/(?:commits|changes)\/([0-9a-f]{7,40})(?:[/?#]|$)/);
  if (commit) {
    return `https://github.com/${commit[1]}/${commit[2]}/commit/${commit[3]}.diff`;
  }
  const pull = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/);
  return pull ? `https://github.com/${pull[1]}/${pull[2]}/pull/${pull[3]}.diff` : null;
}
