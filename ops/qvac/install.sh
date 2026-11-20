#!/usr/bin/env bash
# Opt-in only. Run from the merged tag, never from the agent-writable checkout.
set -euo pipefail
umask 022
cd -- "$(dirname -- "$0")"
base=/opt/continuum-qvac
socket=continuum-qvac.socket
unit=continuum-qvac@.service
units=/etc/systemd/system
exec 9>/run/lock/continuum-qvac-install.lock
flock -n 9
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
python3 -c 'import sys; assert sys.version_info[:2] == (3,14), "Needs Linux x64 Python 3.14 lock"'
getent group continuum >/dev/null
if [[ -e $base || -L $base ]]; then
  # Never replace an existing installation; an upgrade needs its own disk gate.
  cmp -s worker.py "$base/worker.py" && cmp -s deps.lock "$base/deps.lock" &&
    cmp -s "$socket" "$units/$socket" && cmp -s "$unit" "$units/$unit" &&
    systemctl is-active --quiet "$socket" && { echo 'QVAC already installed'; exit 0; }
  echo 'Refusing to overwrite an existing QVAC install' >&2; exit 1
fi
for u in "$units/$socket" "$units/$unit"; do [[ ! -e $u && ! -L $u ]]; done
# Measured runtime footprint 2.55 GB; leave >= 2 GiB on the live volume.
test "$(df -B1 --output=avail /opt | tail -1)" -ge 5000000000
test "$(findmnt -n -o FSTYPE -T /tmp)" = tmpfs
test "$(df -B1 --output=avail /tmp | tail -1)" -ge 2000000000
test "$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)" -ge 4500000
scratch=$(mktemp -d /tmp/continuum-qvac.XXXXXXXX)
stage=$(mktemp -d /opt/.continuum-qvac.XXXXXXXX)
installed=0
cleanup() {
  rc=$?
  if (( rc != 0 && installed )); then
    systemctl disable --now "$socket" >/dev/null 2>&1 || true
    rm -f -- "$units/$socket" "$units/$unit"
    systemctl daemon-reload
    rm -rf -- "$base"
  fi
  rm -rf -- "$scratch" "$stage"
}
trap cleanup EXIT
export TMPDIR="$scratch" PIP_CONFIG_FILE=/dev/null PYTHONNOUSERSITE=1 PIP_NO_CACHE_DIR=1
fetch() {
  curl --proto '=https' --proto-redir '=https' -fsSL --max-time 240 --retry 2 "$1" -o "$2"
  printf '%s  %s\n' "$3" "$2" | sha256sum -c --status
}
wheel=tetherto_qvac_sdk-0.24.0-py3-none-manylinux_2_35_x86_64.whl
fetch "https://github.com/tetherto/qvac/releases/download/sdk-v0.24.0/$wheel" "$scratch/$wheel" 35cf4014ec16312a8e7491aeb2be8dd9f012d37a0e246f9c9450c05e25a7e41a
fetch 'https://files.pythonhosted.org/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl' "$scratch/pip.whl" 9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd
fetch 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf' "$stage/llama.gguf" fa0390e7c043f89ae1847bd6682d748041a99d4ef3de0e0b27d33b6af97a8be8
python3 -m venv --without-pip "$stage/env"
pip_cmd() { PYTHONPATH="$scratch/pip.whl" "$stage/env/bin/python" -m pip --isolated --disable-pip-version-check "$@"; }
pip_cmd install --no-cache-dir --no-compile --only-binary=:all: --require-hashes -r deps.lock
pip_cmd install --no-cache-dir --no-compile --no-index --no-deps "$scratch/$wheel"
install -m 0644 worker.py deps.lock "$stage"
chmod 0755 "$stage"
test "$(df -B1 --output=avail /opt | tail -1)" -ge 2147483648
mv -T "$stage" "$base"; installed=1
install -m 0644 "$socket" "$unit" "$units"
systemctl daemon-reload
systemctl enable --now "$socket"
runuser -u continuum -- python3 - <<'PY'
import json,socket
s=socket.socket(socket.AF_UNIX);s.settimeout(100);s.connect('/run/continuum-qvac.sock')
s.sendall(b'{"question":"Say hello briefly."}\n')
text='';done=False
for line in s.makefile('rb'):
    msg=json.loads(line);text+=msg.get('delta','')
    if msg.get('done'): done=True;break
assert done and text.strip(), 'Local-only acceptance failed'
print('QVAC verified via agent-user socket; no paid request')
PY
df -h /opt
