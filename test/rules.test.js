const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function load(file, names) {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  return vm.runInNewContext(`${source}; ({ ${names} })`);
}

const { classifyChangedFile } = load("t3ChangedFileKind.js", "classifyChangedFile");
const { BUILT_IN_RULES, activeRules, matchingRule } = load("../src/rules.js", "BUILT_IN_RULES, activeRules, matchingRule");

const defaults = { disabledRuleIds: [], customRules: [] };
const isHidden = (file, settings) => Boolean(matchingRule(file, activeRules(settings)));

const DIRS = ["", "src/", "Tests/", "src/__tests__/", "e2e/", "fixtures/", "testdata/", "lib/mocks/", "spec/models/", "src/specs.d/", "contest/", "latest/"];
const NAMES = [
  "app.ts", "app.test.ts", "app.spec.tsx", "app.e2e.js", "app_test.go", "app_spec.rb", "test_api.py", "test_api.rb",
  "conftest.py", "jest.setup.js", "vitest.setup.ts", "UserTest.java", "UserTests.cs", "CartSpec.kt", "Latest.java",
  "usertest.java", "Button.snap", "api.mock.ts", "api.mocks.ts", "user.fixture.json", "db.stub.go", "clock.fake.ts",
  "mocks.ts", "mock", "mockery.ts", "MockServer.ts", "mock-server.ts", "fixtures_A.json", "README.md", "contest.py",
  "a.test.dir.ts", "testing.ts", "spec.ts",
];

test("matches T3 Code's classifier for tests and mocks", () => {
  for (const dir of DIRS) {
    for (const name of NAMES) {
      const file = `${dir}${name}`;
      const kind = classifyChangedFile(file);
      if (kind === "generated") {
        continue;
      }
      assert.equal(isHidden(file, defaults), kind === "tests" || kind === "mocks", file);
    }
  }
});

test("hides generated files inside test folders, unlike T3 Code", () => {
  assert.equal(classifyChangedFile("test/fixtures/bun.lock"), "generated");
  assert.equal(isHidden("test/fixtures/bun.lock", defaults), true);
  assert.equal(isHidden("bun.lock", defaults), false);
});

test("skips disabled built-in rules", () => {
  assert.equal(isHidden("tests/helpers.ts", defaults), true);
  assert.equal(isHidden("tests/helpers.ts", { ...defaults, disabledRuleIds: ["test-folders"] }), false);
  assert.equal(BUILT_IN_RULES.length, 5);
});

test("applies enabled custom rules, ignoring case", () => {
  const settings = {
    disabledRuleIds: [],
    customRules: [
      { id: "a", pattern: "\\.stories\\.tsx$", enabled: true },
      { id: "b", pattern: "^docs/", enabled: false },
    ],
  };
  assert.equal(isHidden("src/Button.STORIES.tsx", settings), true);
  assert.equal(isHidden("docs/intro.md", settings), false);
});
