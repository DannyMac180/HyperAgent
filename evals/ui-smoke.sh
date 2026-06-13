#!/bin/sh
set -eu

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
port="${HYPERAGENT_UI_SMOKE_PORT:-18765}"
log_file=$(mktemp)

cleanup() {
  if [ -n "${server_pid:-}" ]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$log_file"
}
trap cleanup EXIT INT TERM

cd "$repo_root"

command -v node >/dev/null 2>&1 || fail "node is required for the local UI"
node --check scripts/hyperagent-ui.mjs >/dev/null

node scripts/hyperagent-ui.mjs --host 127.0.0.1 --port "$port" >"$log_file" 2>&1 &
server_pid=$!

tries=0
until node -e "fetch('http://127.0.0.1:$port/api/overview').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; do
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    cat "$log_file" >&2
    fail "UI server did not become ready"
  fi
  sleep 0.2
done

node <<EOF
const base = 'http://127.0.0.1:$port';
const overview = await fetch(base + '/api/overview').then((response) => response.json());
if (!overview.repoRoot || overview.safetyMode !== 'human review required') {
  throw new Error('overview missing repo root or safety mode');
}
if (typeof overview.missionCount !== 'number' || overview.missionCount < 0) {
  throw new Error('overview missing mission count');
}
const missions = await fetch(base + '/api/missions').then((response) => response.json());
if (!Array.isArray(missions)) {
  throw new Error('missions endpoint did not return an array');
}
if (overview.missionCount > 0 && (!missions[0] || !missions[0].file)) {
  throw new Error('missions endpoint missing artifacts');
}
const html = await fetch(base + '/').then((response) => response.text());
if (!html.includes('HyperAgent Cockpit') || !html.includes('view-root')) {
  throw new Error('static UI shell missing expected anchors');
}
const action = await fetch(base + '/api/actions/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'status' })
}).then((response) => response.json());
if (!action.ok || !action.output.includes('HyperAgent status')) {
  throw new Error('status action did not run');
}
EOF

printf 'HyperAgent UI smoke passed.\n'
