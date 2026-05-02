#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
label="dev.crowclaw.runtime"
plist_dir="${HOME}/Library/LaunchAgents"
log_dir="${HOME}/Library/Logs/CrowClaw"
data_dir="${HOME}/Library/Application Support/CrowClaw/data"
env_file="${HOME}/Library/Application Support/CrowClaw/runtime.env"
plist_path="${plist_dir}/${label}.plist"

mkdir -p "$plist_dir" "$log_dir" "$data_dir" "$(dirname "$env_file")"

if [[ ! -f "$env_file" ]]; then
  cat >"$env_file" <<EOF
PORT=8787
CROWCLAW_DATA_DIR=${data_dir}
CROWCLAW_DASHBOARD_TOKEN=
OPENAI_API_KEY=
EOF
  chmod 600 "$env_file"
fi

cat >"$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>WorkingDirectory</key>
  <string>${repo_root}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>bash</string>
    <string>-lc</string>
    <string>set -a; source "${env_file}"; set +a; exec /usr/bin/caffeinate -i -s node scripts/docker-serve.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${log_dir}/runtime.log</string>
  <key>StandardErrorPath</key>
  <string>${log_dir}/runtime.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$plist_path"
launchctl kickstart -k "gui/$(id -u)/${label}"

cat <<EOF
Installed ${label}
Plist: ${plist_path}
Environment: ${env_file}
Logs: ${log_dir}
EOF
