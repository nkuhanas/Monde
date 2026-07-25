#!/usr/bin/env bash
set -euo pipefail

MONDE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_TEMPLATE_DIR="$MONDE_ROOT/ops/systemd"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
MONDE_TARGET="monde-dev.target"

render_unit() {
  local source_path="$1"
  local destination_path="$2"
  local escaped_root="${MONDE_ROOT//&/\\&}"
  escaped_root="${escaped_root//|/\\|}"

  sed "s|@MONDE_ROOT@|$escaped_root|g" "$source_path" >"$destination_path.tmp"
  mv "$destination_path.tmp" "$destination_path"
}

install_services() {
  mkdir -p "$SYSTEMD_USER_DIR"
  render_unit "$SYSTEMD_TEMPLATE_DIR/monde-service.service.in" "$SYSTEMD_USER_DIR/monde-service.service"
  render_unit "$SYSTEMD_TEMPLATE_DIR/monde-web.service.in" "$SYSTEMD_USER_DIR/monde-web.service"
  cp "$SYSTEMD_TEMPLATE_DIR/$MONDE_TARGET" "$SYSTEMD_USER_DIR/$MONDE_TARGET"
  systemctl --user daemon-reload
  systemctl --user enable --now "$MONDE_TARGET"
}

uninstall_services() {
  systemctl --user disable --now "$MONDE_TARGET" 2>/dev/null || true
  rm -f \
    "$SYSTEMD_USER_DIR/monde-service.service" \
    "$SYSTEMD_USER_DIR/monde-web.service" \
    "$SYSTEMD_USER_DIR/$MONDE_TARGET"
  systemctl --user daemon-reload
}

case "${1:-status}" in
  install)
    install_services
    ;;
  uninstall)
    uninstall_services
    ;;
  start)
    systemctl --user start "$MONDE_TARGET"
    ;;
  stop)
    systemctl --user stop "$MONDE_TARGET"
    ;;
  restart)
    systemctl --user restart "$MONDE_TARGET"
    ;;
  status)
    systemctl --user status "$MONDE_TARGET" monde-service.service monde-web.service --no-pager
    ;;
  logs)
    journalctl --user -u monde-service.service -u monde-web.service -f
    ;;
  *)
    echo "Usage: $0 {install|uninstall|start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
