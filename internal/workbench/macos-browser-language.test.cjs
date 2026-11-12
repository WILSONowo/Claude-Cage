const assert = require("node:assert/strict");
const test = require("node:test");
const { applyLanguage } = require("./macos-browser-language.cjs");

test("changing region promotes the configured language and preserves other preferences", () => {
  const preferences = {
    intl: { accept_languages: "fr-FR,en-US,en", selected_languages: "fr-FR,en-US,en" },
    browser: { restore_on_startup: 1 },
  };

  assert.equal(applyLanguage(preferences, "en-US"), true);
  assert.deepEqual(preferences.intl, {
    accept_languages: "en-US,fr-FR,en",
    selected_languages: "en-US,fr-FR,en",
  });
  assert.deepEqual(preferences.browser, { restore_on_startup: 1 });
  assert.equal(applyLanguage(preferences, "en-US"), false);

  assert.equal(applyLanguage(preferences, "fr-FR"), true);
  assert.deepEqual(preferences.intl, {
    accept_languages: "fr-FR,en-US,en",
    selected_languages: "fr-FR,en-US,en",
  });
});

test("a new browser profile starts with the configured language", () => {
  const preferences = {};
  assert.equal(applyLanguage(preferences, "ja-JP"), true);
  assert.deepEqual(preferences.intl, { accept_languages: "ja-JP", selected_languages: "ja-JP" });
});
