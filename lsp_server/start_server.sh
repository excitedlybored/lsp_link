#!/usr/bin/env bash
set -e

# ==============================================================================
# Standalone Eclipse JDT Language Server (JDT.LS) Daemon Launcher
# Uses OpenJDK 21 & Eclipse Equinox OSGi Launcher
# ==============================================================================

WORKSPACE_DIR="${1:-.}"
ABS_WORKSPACE=$(cd "$WORKSPACE_DIR" && pwd)
DATA_DIR="/tmp/jdtls_daemon_$(date +%s)_$$"
mkdir -p "$DATA_DIR"

# 1. Locate JavaSE 21
JAVA_BIN=""
for candidate in \
  "/opt/homebrew/opt/openjdk@21/bin/java" \
  "/opt/homebrew/Cellar/openjdk@21/21.0.6/libexec/openjdk.jdk/Contents/Home/bin/java" \
  "/Library/Java/JavaVirtualMachines/openjdk-21.jdk/Contents/Home/bin/java"; do
  if [ -f "$candidate" ]; then
    JAVA_BIN="$candidate"
    break
  fi
done

if [ -z "$JAVA_BIN" ]; then
  JAVA_BIN="java"
fi

# 2. Locate Equinox Launcher Jar & Config
SERVER_DIR=$(find ~/.vscode/extensions ~/.cursor/extensions -type d -name "server" 2>/dev/null | grep "redhat.java" | head -n 1)

if [ -z "$SERVER_DIR" ]; then
  echo "Error: RedHat Java Language Server extension not found in ~/.vscode or ~/.cursor" >&2
  exit 1
fi

LAUNCHER_JAR=$(find "$SERVER_DIR/plugins" -name "org.eclipse.equinox.launcher_*.jar" | head -n 1)

if [ -d "$SERVER_DIR/config_mac_arm" ]; then
  CONFIG_DIR="$SERVER_DIR/config_mac_arm"
else
  CONFIG_DIR="$SERVER_DIR/config_mac"
fi

echo "========================================================================"
echo "⚡ Starting Eclipse JDT Language Server Daemon (JSON-RPC over stdio)"
echo "   Java Binary:    $JAVA_BIN"
echo "   Launcher JAR:   $LAUNCHER_JAR"
echo "   Config Dir:     $CONFIG_DIR"
echo "   Workspace Path: $ABS_WORKSPACE"
echo "   Data Cache:     $DATA_DIR"
echo "========================================================================"

exec "$JAVA_BIN" \
  -Declipse.application=org.eclipse.jdt.ls.core.id1 \
  -Dosgi.bundles.defaultStartLevel=4 \
  -Declipse.product=org.eclipse.jdt.ls.core.product \
  -Dlog.level=ALL \
  -noverify \
  -Xmx2G \
  -XX:+UseG1GC \
  -XX:+UseStringDeduplication \
  --add-modules=ALL-SYSTEM \
  --add-opens java.base/java.util=ALL-UNNAMED \
  --add-opens java.base/java.lang=ALL-UNNAMED \
  -jar "$LAUNCHER_JAR" \
  -configuration "$CONFIG_DIR" \
  -data "$DATA_DIR"
