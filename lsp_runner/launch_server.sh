#!/usr/bin/env bash
set -e

WORKSPACE_DIR="${1:-$PWD/sample_projects/samples-java/springboot}"
DATA_DIR="${2:-/tmp/jdtls_standalone_data}"

JAVA_BIN="/opt/homebrew/opt/openjdk@21/bin/java"
if [ ! -f "$JAVA_BIN" ]; then
    JAVA_BIN="java"
fi

LAUNCHER_JAR=$(find ~/.vscode/extensions/redhat.java-*/server/plugins -name "org.eclipse.equinox.launcher_*.jar" 2>/dev/null | head -n 1)
CONFIG_DIR=$(find ~/.vscode/extensions/redhat.java-*/server -name "config_mac_arm" -o -name "config_mac" 2>/dev/null | head -n 1)

if [ -z "$LAUNCHER_JAR" ] || [ -z "$CONFIG_DIR" ]; then
    echo "Error: Eclipse JDT.LS server files not found in ~/.vscode/extensions/redhat.java-*"
    exit 1
fi

mkdir -p "$DATA_DIR"

echo "================================================================"
echo " Starting Standalone Eclipse JDT.LS Server over stdio"
echo " Java:        $JAVA_BIN"
echo " Workspace:   $WORKSPACE_DIR"
echo " Launcher:    $LAUNCHER_JAR"
echo " Config:      $CONFIG_DIR"
echo " Data Dir:    $DATA_DIR"
echo "================================================================"

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
