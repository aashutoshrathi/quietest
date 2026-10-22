// Built-in rules mirror T3 Code's packages/shared/src/changedFileKind.ts ("tests" and "mocks" kinds).
const BUILT_IN_RULES = [
  {
    id: "test-files",
    label: "Test files",
    example: "app.test.ts, dialer_test.go, test_api.py, conftest.py, jest.setup.js",
    pattern: String.raw`(\.(test|spec|e2e)\.[^./]+$|_(test|spec)\.[^./]+$|(^|/)test_[^/]+\.py$|(^|/)conftest\.py$|(^|/)(vitest|jest)\.setup\.[^./]+$)`,
    flags: "i",
  },
  {
    id: "test-classes",
    label: "Test classes",
    example: "UserTest.java, CartSpec.kt, ApiTests.cs",
    pattern: String.raw`(Tests?|Spec)\.(java|kt|kts|scala|groovy|cs|php|swift|m)$`,
    flags: "",
  },
  {
    id: "test-folders",
    label: "Test folders",
    example: "tests/, __tests__/, e2e/, cypress/, spec/",
    pattern: String.raw`(^|/)(__tests__|__test__|cypress|e2e|spec|specs|test|tests)/`,
    flags: "i",
  },
  {
    id: "mock-files",
    label: "Mocks, fixtures, stubs, fakes, and snapshots",
    example: "api.mock.ts, user.fixture.json, Button.snap, mocks.ts",
    pattern: String.raw`(\.snap$|\.(mocks?|fixtures?|stubs?|fakes?)\.[^./]+$|(^|/)(mocks?|fixtures?|stubs?|fakes?)([-_.A-Z][^/]*)?$)`,
    flags: "",
  },
  {
    id: "mock-folders",
    label: "Mock and fixture folders",
    example: "__mocks__/, __snapshots__/, fixtures/, testdata/",
    pattern: String.raw`(^|/)(__fixtures__|__mocks__|__snapshots__|fakes|fixture|fixtures|mock|mocks|stubs|testdata)/`,
    flags: "i",
  },
];

const CUSTOM_RULE_FLAGS = "i";

async function loadSettings() {
  const stored = await chrome.storage.sync.get(["disabledRuleIds", "customRules"]);
  return {
    disabledRuleIds: stored.disabledRuleIds ?? [],
    customRules: stored.customRules ?? [],
  };
}

function activeRules(settings) {
  const builtIn = BUILT_IN_RULES.filter((rule) => !settings.disabledRuleIds.includes(rule.id));
  const custom = settings.customRules
    .filter((rule) => rule.enabled)
    .map((rule) => ({ ...rule, flags: CUSTOM_RULE_FLAGS }));
  return [...builtIn, ...custom].map((rule) => ({ ...rule, regex: new RegExp(rule.pattern, rule.flags) }));
}

function matchingRule(path, rules) {
  return rules.find((rule) => rule.regex.test(path));
}
