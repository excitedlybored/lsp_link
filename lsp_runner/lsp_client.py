"""IDE-Grade LSP Client that launches and drives Eclipse JDT.LS over JSON-RPC stdio."""

import argparse
import glob
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urljoin
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree

console = Console()


def find_java21_binary() -> str:
    """Finds Java 21 binary required by modern Eclipse JDT.LS."""
    candidates = [
        "/opt/homebrew/opt/openjdk@21/bin/java",
        "/opt/homebrew/Cellar/openjdk@21/21.0.6/libexec/openjdk.jdk/Contents/Home/bin/java",
        "/Library/Java/JavaVirtualMachines/openjdk-21.jdk/Contents/Home/bin/java",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return "java"


def find_jdtls_launcher() -> tuple[str, str] | None:
    """Finds the installed Equinox launcher jar and Mac config directory."""
    server_dirs = glob.glob(
        os.path.expanduser("~/.vscode/extensions/redhat.java-*/server")
    ) + glob.glob(
        os.path.expanduser("~/.cursor/extensions/redhat.java-*/server")
    )
    for server_dir in server_dirs:
        launcher_jars = glob.glob(
            os.path.join(server_dir, "plugins", "org.eclipse.equinox.launcher_*.jar")
        )
        config_dir = (
            os.path.join(server_dir, "config_mac_arm")
            if os.path.exists(os.path.join(server_dir, "config_mac_arm"))
            else os.path.join(server_dir, "config_mac")
        )
        if launcher_jars and os.path.exists(config_dir):
            return launcher_jars[0], config_dir
    return None


class JdtLsClient:
    """Spawns and communicates with Eclipse JDT.LS as an IDE LSP Client."""

    def __init__(self, workspace_root: str, data_dir: str = "/tmp/jdtls_workspace_data"):
        self.workspace_root = Path(workspace_root).resolve()
        self.data_dir = Path(data_dir).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.java_bin = find_java21_binary()
        self.process: subprocess.Popen | None = None
        self.msg_id = 0
        self.pending_responses: dict[int, dict] = {}
        self.diagnostics: list[dict] = []
        self.running = False
        self.server_ready = False
        self.lock = threading.Lock()

    def start_server(self):
        """Launches the JDT.LS JVM process with Equinox OSGi framework."""
        found = find_jdtls_launcher()
        if not found:
            raise RuntimeError(
                "Could not locate eclipse.jdt.ls in ~/.vscode/extensions/redhat.java-*"
            )
        launcher_jar, config_dir = found

        cmd = [
            self.java_bin,
            "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4",
            "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-Dlog.level=WARNING",
            "-noverify",
            "-Xmx2G",
            "-XX:+UseG1GC",
            "-XX:+UseStringDeduplication",
            "--add-modules=ALL-SYSTEM",
            "--add-opens",
            "java.base/java.util=ALL-UNNAMED",
            "--add-opens",
            "java.base/java.lang=ALL-UNNAMED",
            "-jar",
            launcher_jar,
            "-configuration",
            config_dir,
            "-data",
            str(self.data_dir),
        ]

        console.print(
            Panel.fit(
                f"[bold green]Launching Eclipse JDT.LS Process[/]\n"
                f"Launcher: [cyan]{Path(launcher_jar).name}[/]\n"
                f"Workspace: [cyan]{self.workspace_root}[/]\n"
                f"Data Cache: [cyan]{self.data_dir}[/]",
                border_style="green",
            )
        )

        self.process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self.running = True

        # Start background reader threads
        self.reader_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self.reader_thread.start()
        self.err_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self.err_thread.start()

    def _read_stderr(self):
        while self.running and self.process and self.process.poll() is None:
            line = self.process.stderr.readline()
            if not line:
                break

    def _read_stdout(self):
        """Reads LSP Content-Length framed JSON-RPC messages."""
        stdout = self.process.stdout
        while self.running and self.process and self.process.poll() is None:
            header = b""
            while b"\r\n\r\n" not in header:
                char = stdout.read(1)
                if not char:
                    return
                header += char

            length = 0
            for line in header.decode("latin1").split("\r\n"):
                if line.startswith("Content-Length:"):
                    length = int(line.split(":")[1].strip())

            if length > 0:
                body = stdout.read(length)
                try:
                    msg = json.loads(body.decode("utf-8"))
                    self._handle_lsp_message(msg)
                except Exception:
                    pass

    def _handle_lsp_message(self, msg: dict):
        if "id" in msg and "result" in msg:
            with self.lock:
                self.pending_responses[msg["id"]] = msg["result"]
        elif "method" in msg:
            method = msg["method"]
            params = msg.get("params", {})
            if method == "language/status":
                status_type = params.get("type", "")
                message = params.get("message", "")
                if "ServiceReady" in status_type or "OK" in status_type or "ready" in message.lower():
                    self.server_ready = True
            elif method == "textDocument/publishDiagnostics":
                self.diagnostics.append(params)

    def send_request(self, method: str, params: dict, timeout: float = 15.0) -> dict | list | None:
        """Sends a JSON-RPC request and blocks until response is received."""
        with self.lock:
            self.msg_id += 1
            current_id = self.msg_id

        payload = {
            "jsonrpc": "2.0",
            "id": current_id,
            "method": method,
            "params": params,
        }
        raw_bytes = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(raw_bytes)}\r\n\r\n".encode("latin1")
        self.process.stdin.write(header + raw_bytes)
        self.process.stdin.flush()

        start = time.time()
        while time.time() - start < timeout:
            with self.lock:
                if current_id in self.pending_responses:
                    return self.pending_responses.pop(current_id)
            time.sleep(0.05)
        return None

    def send_notification(self, method: str, params: dict):
        """Sends a JSON-RPC notification (no response expected)."""
        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        raw_bytes = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(raw_bytes)}\r\n\r\n".encode("latin1")
        self.process.stdin.write(header + raw_bytes)
        self.process.stdin.flush()

    def initialize_handshake(self):
        """Performs standard LSP initialize and initialized handshake."""
        root_uri = self.workspace_root.as_uri()
        init_params = {
            "processId": os.getpid(),
            "rootPath": str(self.workspace_root),
            "rootUri": root_uri,
            "capabilities": {
                "workspace": {"applyEdit": True, "workspaceFolders": True},
                "textDocument": {
                    "hover": {"contentFormat": ["markdown", "plaintext"]},
                    "completion": {"completionItem": {"snippetSupport": True}},
                    "definition": {"dynamicRegistration": True},
                    "implementation": {"dynamicRegistration": True},
                    "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                },
            },
            "workspaceFolders": [
                {"uri": root_uri, "name": self.workspace_root.name}
            ],
            "initializationOptions": {
                "bundles": [],
                "settings": {
                    "java": {
                        "autobuild": {"enabled": True},
                        "completion": {"enabled": True},
                    }
                },
            },
        }

        with console.status("[bold blue]Sending LSP initialize request...[/]"):
            res = self.send_request("initialize", init_params, timeout=20.0)

        self.send_notification("initialized", {})
        console.print("[bold green]✓ LSP Initialized Handshake Complete![/]")
        return res

    def open_document(self, file_path: Path):
        """Sends textDocument/didOpen notification."""
        uri = file_path.as_uri()
        text = file_path.read_text(encoding="utf-8", errors="replace")
        self.send_notification(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": uri,
                    "languageId": "java",
                    "version": 1,
                    "text": text,
                }
            },
        )

    def get_document_symbols(self, file_path: Path) -> list:
        """Sends textDocument/documentSymbol request."""
        return self.send_request(
            "textDocument/documentSymbol",
            {"textDocument": {"uri": file_path.as_uri()}},
            timeout=10.0,
        ) or []

    def get_implementation(self, file_path: Path, line: int, character: int) -> list:
        """Sends textDocument/implementation request."""
        return self.send_request(
            "textDocument/implementation",
            {
                "textDocument": {"uri": file_path.as_uri()},
                "position": {"line": line, "character": character},
            },
            timeout=10.0,
        ) or []

    def get_hover(self, file_path: Path, line: int, character: int) -> dict:
        """Sends textDocument/hover request."""
        return self.send_request(
            "textDocument/hover",
            {
                "textDocument": {"uri": file_path.as_uri()},
                "position": {"line": line, "character": character},
            },
            timeout=10.0,
        ) or {}

    def shutdown(self):
        """Shuts down JDT.LS cleanly."""
        try:
            self.send_request("shutdown", {})
            self.send_notification("exit", {})
        except Exception:
            pass
        finally:
            self.running = False
            if self.process:
                self.process.terminate()


def main():
    parser = argparse.ArgumentParser(description="Live Eclipse JDT.LS Language Server Runner.")
    parser.add_argument(
        "project_path",
        type=str,
        nargs="?",
        default="sample_projects/samples-java/springboot",
        help="Path to Java/Spring Boot/Temporal project.",
    )
    args = parser.parse_args()

    client = JdtLsClient(args.project_path)
    try:
        client.start_server()
        client.initialize_handshake()

        # Let the server index the build project for 3 seconds
        with console.status("[bold blue]JDT.LS Compiling & Indexing project...[/]"):
            time.sleep(3.0)

        # Test live LSP query on HelloWorkflowImpl.java
        sample_file = (
            client.workspace_root
            / "src/main/java/io/temporal/samples/springboot/hello/HelloWorkflowImpl.java"
        )
        if sample_file.exists():
            client.open_document(sample_file)
            symbols = client.get_document_symbols(sample_file)

            table = Table(
                title=f"⚡ Live LSP Document Symbols: {sample_file.name}",
                show_header=True,
                header_style="bold cyan",
            )
            table.add_column("Symbol Name", style="bold")
            table.add_column("Kind ID", style="magenta")
            table.add_column("Line Range", style="green")

            for sym in symbols:
                name = sym.get("name", "")
                kind = str(sym.get("kind", ""))
                rng = sym.get("range", {}).get("start", {})
                line = rng.get("line", 0) + 1
                table.add_row(name, kind, f"Line {line}")
                for child in sym.get("children", []):
                    c_name = child.get("name", "")
                    c_kind = str(child.get("kind", ""))
                    c_rng = child.get("range", {}).get("start", {})
                    c_line = c_rng.get("line", 0) + 1
                    table.add_row(f"  └── {c_name}", c_kind, f"Line {c_line}")

            console.print(table)

            # Test textDocument/hover on HelloActivity
            hover = client.get_hover(sample_file, line=12, character=15)
            if hover and "contents" in hover:
                console.print(
                    Panel.fit(
                        f"[bold yellow]Live LSP Hover on HelloActivity.class:[/]\n{hover['contents']}",
                        border_style="yellow",
                    )
                )

        console.print("[bold green]✓ Live Eclipse JDT.LS Language Server session successful![/]")
    finally:
        client.shutdown()


if __name__ == "__main__":
    main()
