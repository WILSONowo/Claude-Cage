# shellcheck shell=bash
cage_is_ubuntu() (
  . /etc/os-release
  [ "$ID" = ubuntu ]
)

cage_install_ubuntu_browser() (
  set -euo pipefail
  sudo env DEBIAN_FRONTEND=noninteractive APT_CONFIG="${CAGE_APT_CONFIG:-/dev/null}" apt-get install -y --no-install-recommends \
    snapd dbus-user-session fonts-liberation fonts-dejavu-core xvfb xauth </dev/null

  # snapd downloads and verifies the store assertions in its own process.
  # Keep the short-lived maintenance proxy out of persistent snap settings.
  local unit_dir=/run/systemd/system/snapd.service.d
  local dropin proxy_file
  if [[ -n ${CAGE_INSTALL_PROXY:-} ]]; then
    sudo install -d -m 0755 "$unit_dir"
    proxy_file=$(sudo mktemp /run/browser-install.XXXXXX)
    dropin="$unit_dir/90-${proxy_file##*/}.conf"
    trap 'sudo rm -f "$dropin" "$proxy_file"; sudo systemctl daemon-reload; sudo systemctl restart snapd' EXIT
    printf 'HTTPS_PROXY=%s\nhttps_proxy=%s\n' "$CAGE_INSTALL_PROXY" "$CAGE_INSTALL_PROXY" | sudo tee "$proxy_file" >/dev/null
    printf '[Service]\nEnvironmentFile=%s\n' "$proxy_file" | sudo tee "$dropin" >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl restart snapd
  fi
  sudo snap wait system seed.loaded
  if snap list chromium >/dev/null 2>&1; then
    local channel
    channel=$(LC_ALL=C snap list chromium | awk '$1 == "chromium" {print $4}')
    if [[ $channel != latest/stable && $channel != stable ]]; then
      echo "Installed Chromium follows $channel. Keep that installation and select latest/stable before setting up the workbench." >&2
      return 1
    fi
    sudo snap refresh chromium
  else
    sudo snap install chromium --channel=latest/stable
  fi

  # Chrome for Testing wrote this directory in place. Do not give a browser
  # older than that profile an opportunity to downgrade its database schemas.
  local profile_version=/home/cage-browser/profile/'Last Version'
  if sudo test -s "$profile_version"; then
    local last current
    last=$(sudo -u cage-browser cat "$profile_version")
    current=$(LC_ALL=C snap list chromium | awk '$1 == "chromium" {print $2}')
    if ! dpkg --compare-versions "$current" ge "$last"; then
      echo "Chromium stable $current is older than the existing profile ($last); retry after the stable channel updates." >&2
      return 1
    fi
  fi
  cage_install_ubuntu_launcher
)

# Publish outside the system browser paths. A temporary file and rename also
# replace the old snap symlink without following it into /snap/bin.
cage_install_ubuntu_launcher() (
  set -euo pipefail
  local dir=/usr/local/lib/workbench-browser stage
  sudo install -d -m 0755 "$dir"
  stage=$(sudo mktemp "$dir/.chromium.XXXXXX")
  trap 'sudo rm -f "$stage"' EXIT
  sudo tee "$stage" >/dev/null <<'PYLAUNCH'
#!/usr/bin/python3 -I
import os
import sys
from pathlib import Path

def unused_leveldb(directory, version_key):
    # A failed first launch may create a schema marker and empty batches.
    # Anything else (including compacted tables) may contain newer site data.
    try:
        entries = list(directory.iterdir())
    except FileNotFoundError:
        return True
    version = b"\x01\x07" + version_key + b"\x011"
    for file in entries:
        if file.name in ("CURRENT", "LOCK", "LOG", "LOG.old") or file.name.startswith("MANIFEST-"):
            continue
        if not file.stem.isdigit() or file.suffix != ".log":
            return False
        with file.open("rb") as stream:
            data = stream.read(1025)
        if len(data) > 1024:
            return False
        while data:
            if len(data) < 19 or data[6] != 1:
                return False
            end = 7 + int.from_bytes(data[4:6], "little")
            if end < 19 or end > len(data):
                return False
            # A FULL WAL record holds an 8-byte sequence then a write batch.
            batch = data[15:end]
            if batch not in (b"\x00" * 4, b"\x01\x00\x00\x00" + version):
                return False
            data = data[end:]
    return True

def uses_sqlite(profile):
    default = Path(profile) / "Default"
    try:
        with (default / "LocalStorage").open("rb") as f:
            if f.read(16) != b"SQLite format 3\x00":
                return False
        return (unused_leveldb(default / "Local Storage" / "leveldb", b"VERSION")
                and unused_leveldb(default / "Session Storage", b"version"))
    except OSError:
        return False

if __name__ == "__main__":
    args = sys.argv[1:]
    profile = next((arg.split("=", 1)[1] for arg in args if arg.startswith("--user-data-dir=")), "")
    if profile and uses_sqlite(profile):
        args.insert(0, "--enable-features=DomStorageSqlite")
    os.execv("/snap/bin/chromium", ["chromium", *args])
PYLAUNCH
  sudo chmod 0755 "$stage"
  sudo mv -fT "$stage" "$dir/chromium"
)

cage_install_chromium() {
  if cage_is_ubuntu; then
    cage_install_ubuntu_browser
  else
    cage_cache_chromium --no-install-recommends chromium chromium-l10n
    sudo env DEBIAN_FRONTEND=noninteractive APT_CONFIG="${CAGE_APT_CONFIG:-/dev/null}" apt-get install -y --no-install-recommends chromium chromium-l10n </dev/null
  fi
}

# Jammy ships noVNC 1.0. The shared input/clipboard patch needs 1.6.
# Keep the system package untouched; websockify serves the Cage-owned copy.
cage_install_ubuntu_novnc() (
  set -euo pipefail
  local cache="$HOME/.cache/cage/downloads/$CAGE_UBUNTU_NOVNC_SHA256" stage
  if [ -f /usr/local/share/cage-novnc/VERSION ] && [ "$(cat /usr/local/share/cage-novnc/VERSION)" = "$CAGE_UBUNTU_NOVNC_VERSION" ]; then
    sudo chmod 0755 /usr/local/share/cage-novnc
    return
  fi
  mkdir -p "$cache"
  exec 8>"$cache/lock"
  flock -w 60 8
  cage_download_tool "https://github.com/novnc/noVNC/archive/refs/tags/v$CAGE_UBUNTU_NOVNC_VERSION.tar.gz" "$CAGE_UBUNTU_NOVNC_SHA256" "$cache/novnc.tar.gz"
  sudo install -d -m 0755 /usr/local/share
  stage=$(sudo mktemp -d /usr/local/share/.cage-novnc-XXXXXX)
  trap 'sudo rm -rf "$stage"' EXIT
  sudo tar -xzf "$cache/novnc.tar.gz" --strip-components=1 -C "$stage"
  sudo chmod 0755 "$stage"
  printf '%s\n' "$CAGE_UBUNTU_NOVNC_VERSION" | sudo tee "$stage/VERSION" >/dev/null
  # Called only after cage-webvnc has stopped.
  sudo rm -rf /usr/local/share/cage-novnc
  sudo mv "$stage" /usr/local/share/cage-novnc
)
