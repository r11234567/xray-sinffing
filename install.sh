#!/usr/bin/env bash
set -euo pipefail

APP_NAME="xray-sinffing"
APP_DIR="/opt/$APP_NAME"
ETC_DIR="/etc/$APP_NAME"
STATE_DIR="/var/lib/$APP_NAME"
CONFIG_FILE="$ETC_DIR/config.json"
SERVICE_FILE="/etc/systemd/system/$APP_NAME.service"
SOURCE_ARCHIVE_URL="https://github.com/r11234567/xray-sinffing/archive/refs/heads/main.tar.gz"
RUN_USER="$(printenv XRAY_SINFFING_USER || true)"
XRAY_BIN="$(printenv XRAY_BIN || true)"
XRAY_CONFIG_PATH="$(printenv XRAY_CONFIG_PATH || true)"
XRAY_API_SERVER="$(printenv XRAY_API_SERVER || true)"
ACTION="install"
PATCH_XRAY=1
START_SERVICE=1
RESET_STATE=0
RESEND_REPORT=""

if [ -z "$RUN_USER" ]; then RUN_USER="xraystat"; fi
if [ -z "$XRAY_BIN" ]; then XRAY_BIN="/usr/local/bin/xray"; fi
if [ -z "$XRAY_API_SERVER" ]; then XRAY_API_SERVER="127.0.0.1:10085"; fi

usage() {
  printf '%s\n' \
    "Usage:" \
    "  sudo ./install.sh install [--no-patch-xray] [--no-start]" \
    "  sudo ./install.sh update [--no-patch-xray] [--no-start] [--reset-state] [--resend-weekly|--resend-monthly]" \
    "  sudo ./install.sh uninstall" \
    "  bash -c \"\$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)\" @ install" \
    "  bash -c \"\$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)\" @ update" \
    "  bash -c \"\$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)\" @ uninstall" \
    "" \
    "Actions:" \
    "  install             Install, patch Xray Stats/API, and start the service" \
    "  update              Download the latest release, preserve config/state, and restart" \
    "  uninstall           Remove the service and application; keep config and state" \
    "" \
    "Options:" \
    "  --patch-xray        Patch Xray config (default for install)" \
    "  --no-patch-xray     Install without changing Xray config" \
    "  --no-start          Install without starting the reporter" \
    "  --reset-state       Back up incompatible traffic state and start from a new baseline" \
    "  --resend-weekly     Update and send the current weekly report without a scheduler marker" \
    "  --resend-monthly    Update and send the current monthly report without a scheduler marker" \
    "" \
    "Environment variables:" \
    "  TG_BOT_TOKEN       Telegram bot token" \
    "  TG_CHAT_ID         Telegram user/chat id" \
    "  TG_TOPIC_ID        Telegram forum topic id, optional" \
    "  PROBE_URL          Komari/local probe dashboard link" \
    "  BRAND_NAME         Telegram report brand name" \
    "  NODE_NAME          Display node name" \
    "  TRACK_OUTBOUNDS    Comma list: outbound-tag-1:Primary,outbound-tag-2:Backup" \
    "  XRAY_API_SERVER    Default: 127.0.0.1:10085" \
    "  XRAY_CONFIG_PATH   Default: /usr/local/etc/xray/config.json" \
    "  XRAY_BIN           Default: /usr/local/bin/xray" \
    "  XRAY_SINFFING_USER Runtime user, default: xraystat"
}

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || pwd)"

bootstrap_if_needed() {
  if [ -f "$SCRIPT_DIR/bin/xray-sinffing.js" ] && [ -f "$SCRIPT_DIR/config/config.example.json" ]; then
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required for remote installation." >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "tar is required for remote installation." >&2
    exit 1
  fi
  BOOTSTRAP_DIR="$(mktemp -d)"
  trap 'rm -rf "$BOOTSTRAP_DIR"' EXIT
  echo "Downloading xray-sinffing..."
  curl -fL --retry 3 --connect-timeout 15 "$SOURCE_ARCHIVE_URL" -o "$BOOTSTRAP_DIR/source.tar.gz"
  tar -xzf "$BOOTSTRAP_DIR/source.tar.gz" -C "$BOOTSTRAP_DIR"
  BOOTSTRAP_SOURCE="$BOOTSTRAP_DIR/xray-sinffing-main"
  if [ ! -x "$BOOTSTRAP_SOURCE/install.sh" ] || [ ! -f "$BOOTSTRAP_SOURCE/bin/xray-sinffing.js" ]; then
    echo "Downloaded archive is incomplete." >&2
    exit 1
  fi
  if [ "$(id -u)" -eq 0 ]; then
    bash "$BOOTSTRAP_SOURCE/install.sh" "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -E bash "$BOOTSTRAP_SOURCE/install.sh" "$@"
  else
    echo "Root privileges are required and sudo is not available." >&2
    exit 1
  fi
  exit 0
}

bootstrap_if_needed "$@"

if [ "$#" -gt 0 ] && { [ "$1" = "-h" ] || [ "$1" = "--help" ]; }; then
  usage
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$SCRIPT_DIR/install.sh" "$@"
  fi
  echo "Root privileges are required." >&2
  exit 1
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    install)
      ACTION="install"
      ;;
    update)
      ACTION="update"
      ;;
    uninstall)
      ACTION="uninstall"
      ;;
    --patch-xray)
      PATCH_XRAY=1
      ;;
    --no-patch-xray)
      PATCH_XRAY=0
      ;;
    --no-start)
      START_SERVICE=0
      ;;
    --reset-state)
      RESET_STATE=1
      ;;
    --resend-weekly)
      if [ -n "$RESEND_REPORT" ] && [ "$RESEND_REPORT" != "weekly" ]; then
        echo "Only one resend period can be selected" >&2
        exit 1
      fi
      RESEND_REPORT="weekly"
      ;;
    --resend-monthly)
      if [ -n "$RESEND_REPORT" ] && [ "$RESEND_REPORT" != "monthly" ]; then
        echo "Only one resend period can be selected" >&2
        exit 1
      fi
      RESEND_REPORT="monthly"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

if [ -n "$RESEND_REPORT" ] && [ "$ACTION" != "update" ]; then
  echo "--resend-$RESEND_REPORT requires the update action" >&2
  exit 1
fi
if [ -n "$RESEND_REPORT" ] && [ "$START_SERVICE" -ne 1 ]; then
  echo "--resend-$RESEND_REPORT cannot be combined with --no-start" >&2
  exit 1
fi

uninstall_app() {
  systemctl disable --now "$APP_NAME.service" >/dev/null 2>&1 || true
  rm -f "$SERVICE_FILE"
  rm -rf "$APP_DIR"
  systemctl daemon-reload
  echo "Removed application and service."
  echo "Kept configuration: $ETC_DIR"
  echo "Kept traffic state: $STATE_DIR"
}

if [ "$ACTION" = "uninstall" ]; then
  uninstall_app
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 18 is required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js >= 18 is required. Current: $(node -v)" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required." >&2
  exit 1
fi

detect_xray_config_path() {
  local exec_start detected
  exec_start="$(systemctl show xray.service -p ExecStart --value 2>/dev/null || true)"
  detected="$(XRAY_EXEC_START="$exec_start" node <<'NODE'
const text = process.env.XRAY_EXEC_START || '';
const argvMatch = /argv\[\]=([^;}]*)/.exec(text);
const argv = (argvMatch ? argvMatch[1] : text).trim().split(/\s+/).filter(Boolean);
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i];
  const equals = /^-(?:config|c|confdir)=(.+)$/.exec(token);
  if (equals) {
    process.stdout.write(equals[1]);
    process.exit(0);
  }
  if (['-config', '-c', '-confdir'].includes(token) && argv[i + 1]) {
    process.stdout.write(argv[i + 1]);
    process.exit(0);
  }
}
NODE
)"
  if [ -n "$detected" ]; then printf '%s' "$detected"; fi
}

if [ -z "$XRAY_CONFIG_PATH" ]; then
  XRAY_CONFIG_PATH="$(detect_xray_config_path)"
fi
if [ -z "$XRAY_CONFIG_PATH" ]; then
  XRAY_CONFIG_PATH="/usr/local/etc/xray/config.json"
fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$RUN_USER"
fi
RUN_GROUP="$(id -gn "$RUN_USER")"

install -d -m 0755 "$APP_DIR" "$APP_DIR/bin" "$APP_DIR/config" "$APP_DIR/systemd"
install -d -m 0750 -o "$RUN_USER" -g "$RUN_GROUP" "$STATE_DIR"
install -d -m 0755 -o root -g "$RUN_GROUP" "$ETC_DIR"

install -m 0755 "$SCRIPT_DIR/bin/xray-sinffing.js" "$APP_DIR/bin/xray-sinffing.js"
install -m 0755 "$SCRIPT_DIR/bin/patch-xray-config.js" "$APP_DIR/bin/patch-xray-config.js"
install -m 0644 "$SCRIPT_DIR/package.json" "$APP_DIR/package.json"
install -m 0644 "$SCRIPT_DIR/README.md" "$APP_DIR/README.md"
install -m 0644 "$SCRIPT_DIR/config/config.example.json" "$APP_DIR/config/config.example.json"

if [ ! -f "$CONFIG_FILE" ]; then
  install -m 0644 -o root -g "$RUN_GROUP" "$SCRIPT_DIR/config/config.example.json" "$CONFIG_FILE"
else
  chown root:"$RUN_GROUP" "$CONFIG_FILE"
  chmod 0644 "$CONFIG_FILE"
fi

CONFIG_FILE="$CONFIG_FILE" \
DEFAULT_CONFIG_FILE="$SCRIPT_DIR/config/config.example.json" \
TG_BOT_TOKEN="$(printenv TG_BOT_TOKEN || true)" \
TG_CHAT_ID="$(printenv TG_CHAT_ID || true)" \
TG_TOPIC_ID="$(printenv TG_TOPIC_ID || true)" \
PROBE_URL="$(printenv PROBE_URL || true)" \
BRAND_NAME="$(printenv BRAND_NAME || true)" \
NODE_NAME="$(printenv NODE_NAME || true)" \
TRACK_OUTBOUNDS="$(printenv TRACK_OUTBOUNDS || true)" \
XRAY_API_SERVER="$XRAY_API_SERVER" \
XRAY_CONFIG_PATH="$XRAY_CONFIG_PATH" \
XRAY_BIN="$XRAY_BIN" \
node <<'NODE'
const fs = require('fs');
const file = process.env.CONFIG_FILE;
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const defaults = JSON.parse(fs.readFileSync(process.env.DEFAULT_CONFIG_FILE, 'utf8'));
const mergeMissing = (target, source) => {
  for (const [key, value] of Object.entries(source)) {
    if (target[key] === undefined) target[key] = value;
    else if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      mergeMissing(target[key], value);
    }
  }
};
mergeMissing(cfg, defaults);
cfg.xray = cfg.xray || {};
cfg.xray.binary = process.env.XRAY_BIN || cfg.xray.binary;
cfg.xray.apiServer = process.env.XRAY_API_SERVER || cfg.xray.apiServer;
cfg.xray.configPath = process.env.XRAY_CONFIG_PATH || cfg.xray.configPath;
cfg.telegram = cfg.telegram || {};
if (process.env.TG_BOT_TOKEN) cfg.telegram.botToken = process.env.TG_BOT_TOKEN;
if (process.env.TG_CHAT_ID) cfg.telegram.chatId = process.env.TG_CHAT_ID;
if (process.env.TG_TOPIC_ID) cfg.telegram.topicId = process.env.TG_TOPIC_ID;
cfg.komari = cfg.komari || {};
if (process.env.PROBE_URL) cfg.komari.probeUrl = process.env.PROBE_URL;
if (process.env.BRAND_NAME) cfg.komari.brandName = process.env.BRAND_NAME;
if (process.env.NODE_NAME) cfg.komari.nodeName = process.env.NODE_NAME;
cfg.track = cfg.track || {};
if (process.env.TRACK_OUTBOUNDS) {
  cfg.track.outbounds = process.env.TRACK_OUTBOUNDS.split(',').map((part) => {
    const idx = part.indexOf(':');
    if (idx === -1) return { tag: part.trim(), name: part.trim() };
    return { tag: part.slice(0, idx).trim(), name: part.slice(idx + 1).trim() };
  }).filter((x) => x.tag);
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o644 });
NODE

sed \
  -e "s/^User=.*/User=$RUN_USER/" \
  -e "s/^Group=.*/Group=$RUN_GROUP/" \
  "$SCRIPT_DIR/systemd/xray-sinffing.service" > "$SERVICE_FILE"
chmod 0644 "$SERVICE_FILE"

if [ "$PATCH_XRAY" -eq 1 ]; then
  node "$APP_DIR/bin/patch-xray-config.js" \
    --config "$XRAY_CONFIG_PATH" \
    --api-server "$XRAY_API_SERVER" \
    --xray-bin "$XRAY_BIN" \
    --apply \
    --test
  if systemctl cat xray.service >/dev/null 2>&1; then
    systemctl restart xray.service
  else
    echo "WARN: xray.service was not found. Restart Xray manually before testing." >&2
  fi
fi

grant_xray_config_access() {
  if [ ! -e "$XRAY_CONFIG_PATH" ]; then
    echo "Xray config was not found: $XRAY_CONFIG_PATH" >&2
    exit 1
  fi
  if [ -d "$XRAY_CONFIG_PATH" ]; then
    XRAY_CONFIG_DIR="$XRAY_CONFIG_PATH"
  else
    XRAY_CONFIG_DIR="$(dirname -- "$XRAY_CONFIG_PATH")"
  fi
  XRAY_SERVICE_USER="$(systemctl show xray.service -p User --value 2>/dev/null || true)"
  XRAY_ACCESS_GROUP="$RUN_GROUP"
  if [ -n "$XRAY_SERVICE_USER" ] && [ "$XRAY_SERVICE_USER" != "root" ] && id "$XRAY_SERVICE_USER" >/dev/null 2>&1; then
    XRAY_ACCESS_GROUP="$(id -gn "$XRAY_SERVICE_USER")"
    if ! id -nG "$RUN_USER" | tr ' ' '\n' | grep -Fxq "$XRAY_ACCESS_GROUP"; then
      usermod -a -G "$XRAY_ACCESS_GROUP" "$RUN_USER"
    fi
  fi
  chgrp "$XRAY_ACCESS_GROUP" "$XRAY_CONFIG_DIR"
  chmod 0755 "$XRAY_CONFIG_DIR"
  if [ -d "$XRAY_CONFIG_PATH" ]; then
    while IFS= read -r -d '' config_part; do
      chgrp "$XRAY_ACCESS_GROUP" "$config_part"
      chmod 0644 "$config_part"
    done < <(find "$XRAY_CONFIG_PATH" -maxdepth 1 -type f -name '*.json' -print0)
  else
    chgrp "$XRAY_ACCESS_GROUP" "$XRAY_CONFIG_PATH"
    chmod 0644 "$XRAY_CONFIG_PATH"
  fi
  if command -v runuser >/dev/null 2>&1 && ! runuser -u "$RUN_USER" -- test -r "$XRAY_CONFIG_PATH"; then
    echo "Runtime user $RUN_USER still cannot read Xray config: $XRAY_CONFIG_PATH" >&2
    exit 1
  fi
}

grant_xray_config_access

if [ "$RESET_STATE" -eq 1 ]; then
  systemctl stop "$APP_NAME.service" >/dev/null 2>&1 || true
  if [ -f "$STATE_DIR/traffic-state.json" ]; then
    STATE_BACKUP="$STATE_DIR/traffic-state.json.bak-reset-$(date '+%Y%m%d-%H%M%S')"
    mv "$STATE_DIR/traffic-state.json" "$STATE_BACKUP"
    echo "Traffic state backup: $STATE_BACKUP"
  fi
fi

systemctl daemon-reload
systemctl enable "$APP_NAME.service" >/dev/null

if [ -n "$RESEND_REPORT" ]; then
  systemctl stop "$APP_NAME.service" >/dev/null 2>&1 || true
  if runuser -u "$RUN_USER" -- node "$APP_DIR/bin/xray-sinffing.js" \
    --config "$CONFIG_FILE" --once --report "$RESEND_REPORT"; then
    echo "Resent current $RESEND_REPORT report."
  else
    REPORT_STATUS=$?
    systemctl start "$APP_NAME.service"
    exit "$REPORT_STATUS"
  fi
  systemctl start "$APP_NAME.service"
elif [ "$START_SERVICE" -eq 1 ]; then
  systemctl restart "$APP_NAME.service"
fi

echo
if [ "$ACTION" = "update" ]; then
  echo "Updated $APP_NAME."
else
  echo "Installed $APP_NAME."
fi
echo "Edit configuration: $CONFIG_FILE"
echo "Then restart: systemctl restart $APP_NAME.service"
echo "Status: systemctl status $APP_NAME.service --no-pager"
