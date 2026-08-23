import sys
import argparse
import tree_sitter
import tree_sitter_java

def find_method(node, source_bytes, method_name):
    if node.type == 'method_declaration':
        name_node = node.child_by_field_name('name')
        if name_node and source_bytes[name_node.start_byte:name_node.end_byte].decode('utf-8') == method_name:
            return node
    for child in node.children:
        res = find_method(child, source_bytes, method_name)
        if res: return res
    return None

class CFGBuilder:
    def __init__(self, source_bytes):
        self.source_bytes = source_bytes
        self.node_counter = 0
        self.mermaid = ["flowchart TD", "    classDef default fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#f8fafc;", 
                        "    classDef cond fill:#4c1d95,stroke:#8b5cf6,stroke-width:2px,color:#f5f3ff;", 
                        "    classDef ret fill:#7f1d1d,stroke:#ef4444,stroke-width:2px,color:#fef2f2;"]
        
    def get_text(self, node):
        return self.source_bytes[node.start_byte:node.end_byte].decode('utf-8')
        
    def next_id(self):
        self.node_counter += 1
        return f"n{self.node_counter}"
        
    def sanitize(self, text):
        t = text.replace('"', "'").replace("\\n", " ").strip()
        t = " ".join(t.split())
        if len(t) > 60: t = t[:57] + "..."
        return t
        
    def process_block(self, block_node, parent_ids):
        current_parents = parent_ids
        for child in block_node.named_children:
            if child.type == 'line_comment' or child.type == 'block_comment':
                continue
            current_parents = self.process_statement(child, current_parents)
            if not current_parents:
                break
        return current_parents

    def process_statement(self, stmt, parent_ids):
        if not parent_ids: return []
        stype = stmt.type
        
        if stype == 'if_statement':
            cond_node = stmt.child_by_field_name('condition')
            cond_text = self.get_text(cond_node) if cond_node else "condition"
            cond_id = self.next_id()
            self.mermaid.append(f'    {cond_id}{{"{self.sanitize(cond_text)}"}}:::cond')
            for p in parent_ids:
                # If parent is a branch label like "n1 -- Yes", append to it
                if " -- " in p:
                    self.mermaid.append(f'    {p} --> {cond_id}')
                else:
                    self.mermaid.append(f'    {p} --> {cond_id}')
                
            cons_node = stmt.child_by_field_name('consequence')
            true_parents = [f"{cond_id} -- Yes"]
            if cons_node:
                if cons_node.type == 'block':
                    true_ends = self.process_block(cons_node, true_parents)
                else:
                    true_ends = self.process_statement(cons_node, true_parents)
            else:
                true_ends = [f"{cond_id} -- Yes"]
                
            alt_node = stmt.child_by_field_name('alternative')
            false_parents = [f"{cond_id} -- No"]
            if alt_node:
                if alt_node.type == 'block':
                    false_ends = self.process_block(alt_node, false_parents)
                else:
                    false_ends = self.process_statement(alt_node, false_parents)
            else:
                false_ends = [f"{cond_id} -- No"]
                
            return true_ends + false_ends

        elif stype == 'return_statement':
            ret_id = self.next_id()
            ret_text = self.get_text(stmt)
            self.mermaid.append(f'    {ret_id}(["{self.sanitize(ret_text)}"]):::ret')
            for p in parent_ids:
                self.mermaid.append(f'    {p} --> {ret_id}')
            return []
            
        elif stype in ['while_statement', 'for_statement']:
            cond_node = stmt.child_by_field_name('condition') or stmt
            cond_id = self.next_id()
            self.mermaid.append(f'    {cond_id}{{"Loop: {self.sanitize(self.get_text(cond_node))}"}}:::cond')
            for p in parent_ids:
                self.mermaid.append(f'    {p} --> {cond_id}')
                
            body_node = stmt.child_by_field_name('body')
            body_parents = [f"{cond_id} -- Yes"]
            if body_node:
                if body_node.type == 'block':
                    body_ends = self.process_block(body_node, body_parents)
                else:
                    body_ends = self.process_statement(body_node, body_parents)
                for end in body_ends:
                    self.mermaid.append(f'    {end} --> {cond_id}')
                    
            return [f"{cond_id} -- No"]

        elif stype in ['local_variable_declaration', 'expression_statement', 'assert_statement', 'try_statement']:
            # Currently treating try as a single block for simplicity, but can be expanded
            if stype == 'try_statement':
                body = stmt.child_by_field_name('body')
                return self.process_block(body, parent_ids) if body else parent_ids

            node_id = self.next_id()
            text = self.get_text(stmt)
            self.mermaid.append(f'    {node_id}["{self.sanitize(text)}"]')
            for p in parent_ids:
                self.mermaid.append(f'    {p} --> {node_id}')
            return [node_id]
            
        elif stype == 'block':
            return self.process_block(stmt, parent_ids)
            
        else:
            node_id = self.next_id()
            self.mermaid.append(f'    {node_id}["{stype}"]')
            for p in parent_ids:
                self.mermaid.append(f'    {p} --> {node_id}')
            return [node_id]

def generate_cfg(file_path, method_name):
    LANGUAGE = tree_sitter.Language(tree_sitter_java.language())
    parser = tree_sitter.Parser(LANGUAGE)
    
    with open(file_path, 'rb') as f:
        source_bytes = f.read()
        
    tree = parser.parse(source_bytes)
    method_node = find_method(tree.root_node, source_bytes, method_name)
    
    if not method_node:
        print(f"Error: Method '{method_name}' not found in {file_path}")
        return
        
    body_node = method_node.child_by_field_name('body')
    if not body_node:
        print(f"Error: Method '{method_name}' has no body")
        return
        
    builder = CFGBuilder(source_bytes)
    start_id = builder.next_id()
    builder.mermaid.append(f'    {start_id}(["Start: {method_name}"])')
    
    end_parents = builder.process_block(body_node, [start_id])
    
    output_dir = Path(file_path).parent
    # Let's save it to the nearest .gitnexus dir or just the current dir
    # For now, put it in the same directory as the script or a target dir
    import os
    gitnexus_dir = os.path.join(os.getcwd(), "examples", "01_spring_boot_banking", ".gitnexus")
    os.makedirs(gitnexus_dir, exist_ok=True)
    
    out_file = os.path.join(gitnexus_dir, f"{method_name}_cfg.mmd")
    
    with open(out_file, 'w') as f:
        f.write("\n".join(builder.mermaid))
        
    print(f"✅ CFG generated successfully!")
    print(f"📂 Output saved to: {out_file}")
    
    # Auto-generate SVG
    svg_file = out_file.replace('.mmd', '.svg')
    print(f"⏳ Generating SVG visualization via mermaid-cli...")
    import subprocess
    try:
        subprocess.run(
            ["npx", "-y", "@mermaid-js/mermaid-cli", "-i", out_file, "-o", svg_file],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        print(f"🎨 SVG saved to: {svg_file}")
    except Exception as e:
        print(f"⚠️ Failed to generate SVG automatically: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate CFG for a Java method")
    parser.add_argument("file", help="Path to Java file")
    parser.add_argument("method", help="Name of the method")
    args = parser.parse_args()
    from pathlib import Path
    generate_cfg(args.file, args.method)
