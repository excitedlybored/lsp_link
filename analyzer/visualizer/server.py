#!/usr/bin/env python3
"""
LSP-Link Visualizer Server.

Launches a fast, zero-dependency local web server to explore and visualize
the compiler-verified knowledge graph and execution flows in real time.
"""

import sys
import os
import json
import http.server
import socketserver
import webbrowser
from pathlib import Path

PORT = 4040

class VisualizerHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, target_dir="sample_projects/spring-boot-demo", **kwargs):
        self.target_dir = Path(target_dir).resolve()
        self.visualizer_dir = Path(__file__).parent.resolve()
        super().__init__(*args, directory=str(self.visualizer_dir), **kwargs)

    def do_GET(self):
        if self.path == "/api/graph":
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            graph_file = self.target_dir / ".gitnexus" / "graph.json"
            if graph_file.exists():
                with open(graph_file, "r", encoding="utf-8") as f:
                    self.wfile.write(f.read().encode("utf-8"))
            else:
                self.wfile.write(json.dumps({"nodes": [], "relationships": []}).encode("utf-8"))
            return

        if self.path == "/api/meta":
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.end_headers()
            meta_file = self.target_dir / ".gitnexus" / "meta.json"
            if meta_file.exists():
                with open(meta_file, "r", encoding="utf-8") as f:
                    self.wfile.write(f.read().encode("utf-8"))
            else:
                self.wfile.write(json.dumps({}).encode("utf-8"))
            return

        return super().do_GET()

def start_server(target_project: str = "sample_projects/spring-boot-demo", open_browser: bool = False):
    target_path = Path(target_project).resolve()
    print("==================================================")
    print("🌐 LSP-LINK INTERACTIVE KNOWLEDGE GRAPH VISUALIZER")
    print(f"   Target Project: {target_path}")
    print(f"   Server URL:     http://localhost:{PORT}")
    print("==================================================")

    handler = lambda *args, **kwargs: VisualizerHandler(*args, target_dir=target_path, **kwargs)

    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(f"🚀 Visualizer running at http://localhost:{PORT}")
        print("   Press Ctrl+C to stop.\n")
        if open_browser:
            webbrowser.open(f"http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down visualizer server.")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_projects/spring-boot-demo"
    start_server(target)
