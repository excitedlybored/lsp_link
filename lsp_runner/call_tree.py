"""LSP-driven Dependency Call Tree Generator using Eclipse JDT.LS Call Hierarchy API."""

import argparse
import glob
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from rich.console import Console
from rich.panel import Panel
from rich.tree import Tree

console = Console()


def find_java21_binary() -> str:
    candidates = [
        "/opt/homebrew/opt/openjdk@21/bin/java",
        "/opt/homebrew/Cellar/openjdk@21/21.0.6/libexec/openjdk.jdk/Contents/Home/bin/java",
        "/Library/Java/JavaVirtualMachines/openjdk-21.jdk/Contents/Home/bin/java",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return "java"


def find_jdtls_launcher() -> tuple[str, str]:
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
    raise RuntimeError("Eclipse JDT.LS launcher not found.")


class JdtLsCallTreeClient:
    """LSP Client focused on retrieving Call Hierarchy Trees from Eclipse JDT.LS."""

    def __init__(self, workspace_path: str):
        self.workspace_path = Path(workspace_path).resolve()
        self.data_dir = Path(f"/tmp/jdtls_calltree_{os.getpid()}").resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.process: subprocess.Popen | None = None
        self.msg_id = 0
        self.responses: dict[int, dict] = {}
        self.service_ready = threading.Event()
        self.running = False
        self.lock = threading.Lock()

    def start(self):
        java_bin = find_java21_binary()
        launcher_jar, config_dir = find_jdtls_launcher()

        cmd = [
            java_bin,
            "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4",
            "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-Dlog.level=ALL",
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

        self.process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self.running = True

        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stderr(self):
        while self.running and self.process and self.process.poll() is None:
            self.process.stderr.readline()

    def _read_stdout(self):
        stdout = self.process.stdout
        while self.running and self.process and self.process.poll() is None:
            header = b""
            while b"\r\n\r\n" not in header:
                c = stdout.read(1)
                if not c:
                    return
                header += c

            length = 0
            for l in header.decode("latin1").split("\r\n"):
                if l.startswith("Content-Length:"):
                    length = int(l.split(":")[1].strip())

            if length > 0:
                body = stdout.read(length)
                try:
                    msg = json.loads(body.decode("utf-8"))
                    if "id" in msg and "result" in msg:
                        with self.lock:
                            self.responses[msg["id"]] = msg["result"]
                    elif msg.get("method") == "language/status":
                        if msg.get("params", {}).get("type") == "ServiceReady":
                            self.service_ready.set()
                except Exception:
                    pass

    def send_request(self, method: str, params: dict, timeout: float = 20.0):
        with self.lock:
            self.msg_id += 1
            cid = self.msg_id

        payload = {
            "jsonrpc": "2.0",
            "id": cid,
            "method": method,
            "params": params,
        }
        raw = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(raw)}\r\n\r\n".encode("latin1")
        self.process.stdin.write(header + raw)
        self.process.stdin.flush()

        start = time.time()
        while time.time() - start < timeout:
            with self.lock:
                if cid in self.responses:
                    return self.responses.pop(cid)
            time.sleep(0.05)
        return None

    def send_notification(self, method: str, params: dict):
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        raw = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(raw)}\r\n\r\n".encode("latin1")
        self.process.stdin.write(header + raw)
        self.process.stdin.flush()

    def initialize(self):
        root_uri = self.workspace_path.as_uri()
        init_params = {
            "processId": os.getpid(),
            "rootUri": root_uri,
            "capabilities": {
                "workspace": {"workspaceFolders": True},
                "textDocument": {
                    "callHierarchy": {"dynamicRegistration": True},
                    "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                    "definition": {"dynamicRegistration": True},
                    "implementation": {"dynamicRegistration": True},
                    "references": {"dynamicRegistration": True},
                },
            },
            "initializationOptions": {
                "settings": {
                    "java": {
                        "autobuild": {"enabled": True},
                        "import": {"gradle": {"enabled": True}, "maven": {"enabled": True}},
                    }
                }
            },
        }
        res = self.send_request("initialize", init_params, timeout=30.0)
        self.send_notification("initialized", {})
        return res

    def open_document(self, file_path: Path):
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

    def prepare_call_hierarchy(self, file_path: Path, line: int, character: int) -> list:
        """textDocument/prepareCallHierarchy returns CallHierarchyItem[]"""
        return self.send_request(
            "textDocument/prepareCallHierarchy",
            {
                "textDocument": {"uri": file_path.as_uri()},
                "position": {"line": line, "character": character},
            },
        ) or []

    def get_outgoing_calls(self, item: dict) -> list:
        """callHierarchy/outgoingCalls returns CallHierarchyOutgoingCall[]"""
        return self.send_request("callHierarchy/outgoingCalls", {"item": item}) or []

    def get_incoming_calls(self, item: dict) -> list:
        """callHierarchy/incomingCalls returns CallHierarchyIncomingCall[]"""
        return self.send_request("callHierarchy/incomingCalls", {"item": item}) or []

    def shutdown(self):
        try:
            self.send_request("shutdown", {}, timeout=5.0)
            self.send_notification("exit", {})
        except Exception:
            pass
        finally:
            self.running = False
            if self.process:
                self.process.terminate()


def build_call_tree(
    client: JdtLsCallTreeClient,
    file_path: Path,
    method_line: int,
    method_char: int,
    direction: str = "outgoing",
    max_depth: int = 3,
    html_out: str | None = None,
    mermaid_out: str | None = None,
):
    """Builds and prints a hierarchical tree of calls from LSP, optionally exporting HTML/Mermaid."""
    client.open_document(file_path)
    time.sleep(0.5)

    items = client.prepare_call_hierarchy(file_path, line=method_line, character=method_char)
    if not items:
        console.print(f"[bold yellow]No CallHierarchy item found at {file_path.name}:{method_line + 1}[/]")
        return

    root_item = items[0]
    root_name = root_item.get("name", "Unknown")
    root_container = root_item.get("containerName", "")

    title = f"[bold green]📞 LSP Dependency Call Tree ({direction.upper()}): {root_container}.{root_name}[/]"
    tree = Tree(title)

    visited = set()
    graph_nodes = []
    graph_edges = []

    def get_node_id(item):
        uri = item.get("uri", "").split("/")[-1]
        return f"{item.get('containerName', '')}.{item.get('name', '')}\n({uri})"

    root_id = get_node_id(root_item)
    graph_nodes.append({"id": root_id, "label": root_id, "is_root": True})

    def expand(node, current_item, depth):
        if depth >= max_depth:
            return

        item_key = f"{current_item.get('uri')}:{current_item.get('name')}:{current_item.get('range')}"
        if item_key in visited:
            return
        visited.add(item_key)

        current_id = get_node_id(current_item)

        if direction == "outgoing":
            calls = client.get_outgoing_calls(current_item)
            for call in calls:
                to_item = call.get("to", {})
                to_name = to_item.get("name", "Unknown")
                to_container = to_item.get("containerName", "")
                to_uri = to_item.get("uri", "").split("/")[-1]
                to_id = get_node_id(to_item)

                graph_nodes.append({"id": to_id, "label": to_id, "is_root": False})
                graph_edges.append({"from": current_id, "to": to_id, "label": "calls"})

                child_node = node.add(
                    f"[bold cyan]↳ calls:[/] [yellow]{to_container}.{to_name}[/] [dim]({to_uri})[/]"
                )
                expand(child_node, to_item, depth + 1)
        else:
            calls = client.get_incoming_calls(current_item)
            for call in calls:
                from_item = call.get("from", {})
                from_name = from_item.get("name", "Unknown")
                from_container = from_item.get("containerName", "")
                from_uri = from_item.get("uri", "").split("/")[-1]
                from_id = get_node_id(from_item)

                graph_nodes.append({"id": from_id, "label": from_id, "is_root": False})
                graph_edges.append({"from": from_id, "to": current_id, "label": "calls"})

                child_node = node.add(
                    f"[bold magenta]⮤ called by:[/] [yellow]{from_container}.{from_name}[/] [dim]({from_uri})[/]"
                )
                expand(child_node, from_item, depth + 1)

    expand(tree, root_item, 0)
    console.print(tree)

    # 1. Mermaid Export
    mermaid_code = ["```mermaid", "flowchart TD"]
    for e in graph_edges:
        src = e["from"].replace('"', '\\"').replace("\n", "<br/>")
        dst = e["to"].replace('"', '\\"').replace("\n", "<br/>")
        mermaid_code.append(f'    "{src}" -->|calls| "{dst}"')
    mermaid_code.append("```")
    mermaid_str = "\n".join(mermaid_code)

    if mermaid_out:
        Path(mermaid_out).write_text(mermaid_str, encoding="utf-8")
        console.print(f"[bold green]✓ Mermaid diagram exported to:[/] [cyan]{mermaid_out}[/]")

    # 2. HTML Interactive Graph Export (Vis.js Network)
    if html_out:
        unique_nodes = {n["id"]: n for n in graph_nodes}.values()
        vis_nodes = [
            {
                "id": n["id"],
                "label": n["label"],
                "color": "#10b981" if n["is_root"] else "#3b82f6",
                "font": {"color": "#ffffff", "face": "monospace"},
                "shape": "box",
                "margin": 12,
            }
            for n in unique_nodes
        ]
        vis_edges = [
            {
                "from": e["from"],
                "to": e["to"],
                "arrows": "to",
                "color": "#94a3b8",
                "font": {"color": "#64748b", "align": "middle"},
            }
            for e in graph_edges
        ]

        html_template = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>LSP Dependency Call Tree: {root_container}.{root_name}</title>
    <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
    <style>
        body {{
            margin: 0;
            padding: 0;
            background-color: #0f172a;
            color: #f8fafc;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }}
        #header {{
            padding: 16px 24px;
            background: #1e293b;
            border-bottom: 1px solid #334155;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }}
        h1 {{
            font-size: 1.15rem;
            margin: 0;
            color: #38bdf8;
        }}
        .badge {{
            background: #0284c7;
            padding: 4px 10px;
            border-radius: 9999px;
            font-size: 0.8rem;
            font-weight: bold;
        }}
        #network {{
            width: 100vw;
            height: calc(100vh - 65px);
        }}
    </style>
</head>
<body>
    <div id="header">
        <h1>📞 Live LSP Dependency Call Tree: <span style="color:#a5f3fc;">{root_container}.{root_name}</span></h1>
        <span class="badge">{direction.upper()} FLOW</span>
    </div>
    <div id="network"></div>
    <script type="text/javascript">
        var nodes = new vis.DataSet({json.dumps(vis_nodes)});
        var edges = new vis.DataSet({json.dumps(vis_edges)});
        var container = document.getElementById('network');
        var data = {{ nodes: nodes, edges: edges }};
        var options = {{
            layout: {{
                hierarchical: {{
                    direction: 'UD',
                    sortMethod: 'directed',
                    nodeSpacing: 220,
                    levelSeparation: 150
                }}
            }},
            physics: false,
            nodes: {{
                borderWidth: 2,
                shadow: true
            }},
            edges: {{
                width: 2,
                smooth: {{ type: 'cubicBezier', forceDirection: 'vertical', roundness: 0.4 }}
            }}
        }};
        var network = new vis.Network(container, data, options);
    </script>
</body>
</html>
"""
        Path(html_out).write_text(html_template, encoding="utf-8")
        console.print(f"[bold green]✓ Interactive HTML Visualizer exported to:[/] [cyan]{html_out}[/]")


def main():
    parser = argparse.ArgumentParser(description="LSP Dependency Call Tree Explorer & Visualizer.")
    parser.add_argument(
        "project_path",
        type=str,
        nargs="?",
        default="sample_projects/samples-java/springboot",
        help="Path to project directory.",
    )
    parser.add_argument(
        "--file",
        type=str,
        default="src/main/java/io/temporal/samples/springboot/SamplesController.java",
        help="Relative path to target Java file.",
    )
    parser.add_argument(
        "--line",
        type=int,
        default=40,
        help="0-indexed line number of target method (default: line 40 for helloSample).",
    )
    parser.add_argument(
        "--char",
        type=int,
        default=15,
        help="0-indexed character position.",
    )
    parser.add_argument(
        "--direction",
        choices=["outgoing", "incoming"],
        default="outgoing",
        help="Call tree direction: 'outgoing' (calls made) or 'incoming' (callers).",
    )
    parser.add_argument(
        "--depth",
        type=int,
        default=3,
        help="Max expansion depth (default: 3).",
    )
    parser.add_argument(
        "--export-html",
        type=str,
        default="call_tree.html",
        help="Output HTML visualization file (default: call_tree.html).",
    )
    parser.add_argument(
        "--export-mermaid",
        type=str,
        default="call_tree.md",
        help="Output Mermaid markdown file (default: call_tree.md).",
    )

    args = parser.parse_args()
    workspace = Path(args.project_path).resolve()
    target_file = workspace / args.file

    if not target_file.exists():
        console.print(f"[bold red]Error:[/] Target file '{target_file}' not found.")
        sys.exit(1)

    client = JdtLsCallTreeClient(str(workspace))
    try:
        console.print(
            Panel.fit(
                f"[bold magenta]⚡ Live LSP Call Hierarchy Tree Visualizer[/]\n"
                f"Project: [cyan]{workspace.name}[/]\n"
                f"Target Method Location: [cyan]{args.file}:{args.line + 1}[/]\n"
                f"Direction: [yellow]{args.direction.upper()}[/]\n"
                f"HTML Export: [cyan]{args.export_html}[/]\n"
                f"Mermaid Export: [cyan]{args.export_mermaid}[/]",
                border_style="magenta",
            )
        )

        client.start()
        client.initialize()

        with console.status("[bold yellow]Waiting for JDT.LS compilation...[/]"):
            client.service_ready.wait(timeout=45.0)

        build_call_tree(
            client=client,
            file_path=target_file,
            method_line=args.line,
            method_char=args.char,
            direction=args.direction,
            max_depth=args.depth,
            html_out=args.export_html,
            mermaid_out=args.export_mermaid,
        )

    finally:
        client.shutdown()


if __name__ == "__main__":
    main()

