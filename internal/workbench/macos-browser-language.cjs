const { execFileSync, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

function applyLanguage(preferences, language) {
  const intl = preferences.intl ??= {};
  let changed = false;
  for (const key of ["accept_languages", "selected_languages"]) {
    const languages = typeof intl[key] === "string" ? intl[key].split(",").filter(Boolean) : [];
    const updated = [language, ...languages.filter(entry => entry.toLowerCase() !== language.toLowerCase())].join(",");
    changed ||= intl[key] !== updated;
    intl[key] = updated;
  }
  return changed;
}

async function syncLanguage(language) {
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(language)) throw new Error("Invalid browser language");
  const browser = path.join(homedir(), "Library", "Application Support", "Cage", "Browser");
  const preferencesFile = path.join(browser, "Default", "Preferences");
  const label = "dev.cage.GuestBrowser";
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${label}`;
  const plist = path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const launchctl = "/bin/launchctl";

  function readPreferences() {
    try { return JSON.parse(fs.readFileSync(preferencesFile, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  const wasLoaded = spawnSync(launchctl, ["print", service], { stdio: "ignore" }).status === 0;
  const canStart = wasLoaded || (fs.existsSync(plist) && spawnSync(launchctl, ["print", domain], { stdio: "ignore" }).status === 0);
  function startBrowser() {
    execFileSync(launchctl, ["bootstrap", domain, plist]);
  }
  if (!applyLanguage(readPreferences(), language)) {
    // Retry the browser launch if a previous check saved the preferences but could not relaunch it.
    if (!wasLoaded && canStart) startBrowser();
    return !wasLoaded && canStart;
  }
  // Chrome writes this profile on shutdown, so update it only after Chrome has exited.
  if (wasLoaded) execFileSync(launchctl, ["bootout", service]);
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const processes = execFileSync("/bin/ps", ["-ax", "-ww", "-o", "command="], { encoding: "utf8" });
      const running = processes.split("\n").some(command =>
        command.startsWith("/Applications/Google Chrome.app/") && command.includes(`--user-data-dir=${browser}`));
      if (!running) break;
      if (Date.now() >= deadline) throw new Error("Cage browser is still closing");
      await delay(200);
    }

    const preferences = readPreferences();
    if (applyLanguage(preferences, language)) {
      fs.mkdirSync(path.dirname(preferencesFile), { recursive: true, mode: 0o700 });
      const pending = `${preferencesFile}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(pending, JSON.stringify(preferences), { mode: 0o600, flag: "wx" });
        fs.renameSync(pending, preferencesFile);
      } finally {
        fs.rmSync(pending, { force: true });
      }
    }
  } finally {
    if (canStart) startBrowser();
  }
  return true;
}

module.exports = { applyLanguage };
if (require.main === module || (!module.parent && process.argv[1] === "-")) {
  syncLanguage(process.argv[2]).then(changed => {
    if (changed) process.stdout.write("updated");
  }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
