package io.gitnexus.jdt.batch;

import java.io.BufferedWriter;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.IStatus;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.JavaModelException;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.ASTParser;
import org.eclipse.jdt.core.dom.ASTRequestor;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.AnnotationTypeDeclaration;
import org.eclipse.jdt.core.dom.AnnotationTypeMemberDeclaration;
import org.eclipse.jdt.core.dom.ClassInstanceCreation;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.ConstructorInvocation;
import org.eclipse.jdt.core.dom.CreationReference;
import org.eclipse.jdt.core.dom.EnumDeclaration;
import org.eclipse.jdt.core.dom.ExpressionMethodReference;
import org.eclipse.jdt.core.dom.IBinding;
import org.eclipse.jdt.core.dom.IMethodBinding;
import org.eclipse.jdt.core.dom.ITypeBinding;
import org.eclipse.jdt.core.dom.IVariableBinding;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.MethodInvocation;
import org.eclipse.jdt.core.dom.Name;
import org.eclipse.jdt.core.dom.PackageDeclaration;
import org.eclipse.jdt.core.dom.VariableDeclarationFragment;
import org.eclipse.jdt.core.dom.SingleVariableDeclaration;
import org.eclipse.jdt.core.dom.EnumConstantDeclaration;
import org.eclipse.jdt.core.dom.FieldDeclaration;
import org.eclipse.jdt.core.dom.RecordDeclaration;
import org.eclipse.jdt.core.dom.SimpleName;
import org.eclipse.jdt.core.dom.SuperConstructorInvocation;
import org.eclipse.jdt.core.dom.SuperMethodInvocation;
import org.eclipse.jdt.core.dom.SuperMethodReference;
import org.eclipse.jdt.core.dom.TypeDeclaration;
import org.eclipse.jdt.core.dom.TypeMethodReference;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.internal.core.JavaModelManager;

/** Binding-aware, bounded, streamed Java fact collection inside JDT.LS. */
public final class BatchCommandHandler implements IDelegateCommandHandler {
  public static final String COMMAND = "gitnexus.java.collectBatch";
  public static final String AWAIT_INDEX_COMMAND = "gitnexus.java.awaitIndex";
  public static final int SCHEMA_VERSION = 1;

  @Override
  public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor) throws Exception {
    if (AWAIT_INDEX_COMMAND.equals(commandId)) return awaitIndex(monitor);
    if (!COMMAND.equals(commandId)) throw new IllegalArgumentException("Unsupported command: " + commandId);
    if (arguments.isEmpty()) throw new IllegalArgumentException("collectBatch requires an output path");
    Path output = Path.of(String.valueOf(arguments.get(0))).toAbsolutePath().normalize();
    int requestedBatchSize = arguments.size() > 1
        ? arguments.get(1) instanceof Number number
            ? number.intValue()
            : (int) Double.parseDouble(String.valueOf(arguments.get(1)))
        : 256;
    int batchSize = Math.max(1, Math.min(1000, requestedBatchSize));
    Files.createDirectories(output.getParent());
    Path partial = output.resolveSibling(output.getFileName() + ".partial");
    Files.deleteIfExists(partial);
    Counter counter = new Counter();
    IJavaProject[] projects = JavaCore.create(ResourcesPlugin.getWorkspace().getRoot()).getJavaProjects();
    List<ICompilationUnit> allUnits = new ArrayList<>();
    for (IJavaProject project : projects) {
      if (project.exists() && project.isOpen()) collectUnits(project, allUnits);
    }
    monitor.beginTask("Collecting batch Java semantics", allUnits.size());
    try (BufferedWriter writer = Files.newBufferedWriter(partial, StandardCharsets.UTF_8)) {
      for (IJavaProject project : projects) {
        if (!project.exists() || !project.isOpen()) continue;
        List<ICompilationUnit> units = new ArrayList<>();
        collectUnits(project, units);
        for (int from = 0; from < units.size(); from += batchSize) {
          if (monitor.isCanceled()) throw new InterruptedException("Batch Java collection cancelled");
          int to = Math.min(units.size(), from + batchSize);
          parse(project, units.subList(from, to), writer, counter, monitor);
          monitor.worked(to - from);
          monitor.subTask(project.getElementName() + ": " + to + "/" + units.size());
        }
      }
      write(writer, map("kind", "summary", "schemaVersion", SCHEMA_VERSION,
          "documents", counter.documents, "declarations", counter.declarations,
          "occurrences", counter.occurrences, "calls", counter.calls,
          "typeEdges", counter.typeEdges, "unresolved", counter.unresolved,
          "failedDocuments", counter.failedDocuments));
    } catch (Exception error) {
      Files.deleteIfExists(partial);
      throw error;
    } finally {
      monitor.done();
    }
    atomicMove(partial, output);
    String sha256 = sha256(output);
    Path manifest = output.resolveSibling(output.getFileName() + ".manifest.json");
    String status = counter.failedDocuments == 0 ? "complete" : "partial";
    Files.writeString(manifest, json(map("schemaVersion", SCHEMA_VERSION, "status", status,
        "output", output.toString(), "sha256", sha256, "documents", counter.documents,
        "declarations", counter.declarations, "occurrences", counter.occurrences,
        "calls", counter.calls, "typeEdges", counter.typeEdges, "unresolved", counter.unresolved,
        "failedDocuments", counter.failedDocuments, "firstError", counter.firstError)),
        StandardCharsets.UTF_8);
    return map("schemaVersion", SCHEMA_VERSION, "status", status, "output", output.toString(),
        "manifest", manifest.toString(), "sha256", sha256, "documents", counter.documents,
        "failedDocuments", counter.failedDocuments, "firstError", counter.firstError);
  }

  /** Make JDT's global indexing barrier explicit and cancellable. */
  private static Object awaitIndex(IProgressMonitor monitor) {
    monitor.beginTask("Waiting for JDT Java index", IProgressMonitor.UNKNOWN);
    try {
      IStatus status = JavaModelManager.getIndexManager().waitForIndex(true, monitor);
      if (monitor.isCanceled()) throw new IllegalStateException("JDT Java index wait was cancelled");
      if (status.matches(IStatus.ERROR)) throw new IllegalStateException(status.getMessage(), status.getException());
      return map("schemaVersion", SCHEMA_VERSION, "status", "complete", "severity", status.getSeverity());
    } finally {
      monitor.done();
    }
  }

  private static void collectUnits(IJavaProject project, List<ICompilationUnit> result) throws JavaModelException {
    for (var root : project.getPackageFragmentRoots()) {
      if (root.getKind() != org.eclipse.jdt.core.IPackageFragmentRoot.K_SOURCE) continue;
      for (var child : root.getChildren()) {
        if (child instanceof org.eclipse.jdt.core.IPackageFragment fragment) {
          for (ICompilationUnit unit : fragment.getCompilationUnits()) result.add(unit);
        }
      }
    }
  }

  private static void parse(IJavaProject project, List<ICompilationUnit> units, BufferedWriter writer,
      Counter counter, IProgressMonitor monitor) {
    ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
    parser.setProject(project);
    parser.setResolveBindings(true);
    parser.setBindingsRecovery(true);
    parser.setStatementsRecovery(true);
    parser.createASTs(units.toArray(ICompilationUnit[]::new), new String[0], new ASTRequestor() {
      @Override public void acceptAST(ICompilationUnit source, CompilationUnit ast) {
        try {
          String uri = sourceUri(source);
          counter.documents++;
          write(writer, map("kind", "document", "uri", uri, "project", project.getElementName()));
          ast.accept(new FactVisitor(ast, uri, writer, counter));
        } catch (BatchWriteException error) {
          throw error;
        } catch (RuntimeException error) {
          try {
            counter.failedDocuments++;
            String detail = error.getClass().getName() + ": " + String.valueOf(error.getMessage());
            if (counter.firstError == null) counter.firstError = source.getPath() + ": " + detail;
            write(writer, map("kind", "error", "uri", sourceUri(source), "message", detail));
          } catch (IOException writeError) {
            throw new BatchWriteException(writeError);
          }
        } catch (IOException error) {
          throw new BatchWriteException(error);
        }
      }
    }, monitor);
  }

  private static final class FactVisitor extends ASTVisitor {
    private final CompilationUnit unit;
    private final String uri;
    private final BufferedWriter writer;
    private final Counter counter;
    FactVisitor(CompilationUnit unit, String uri, BufferedWriter writer, Counter counter) {
      this.unit = unit; this.uri = uri; this.writer = writer; this.counter = counter;
    }
    @Override public void preVisit(ASTNode node) {
      try {
        if (node instanceof TypeDeclaration value) {
          ITypeBinding binding = value.resolveBinding();
          declaration(value, value.getName(), binding, value.isInterface() ? "interface" : "class");
          if (!value.isInterface() && noExplicitConstructor(value.getMethods())) {
            implicitConstructor(value, value.getName(), binding);
          }
        }
        else if (node instanceof EnumDeclaration value) declaration(value, value.getName(), value.resolveBinding(), "enum");
        else if (node instanceof RecordDeclaration value) declaration(value, value.getName(), value.resolveBinding(), "record");
        else if (node instanceof AnnotationTypeDeclaration value) declaration(value, value.getName(), value.resolveBinding(), "annotation");
        else if (node instanceof AnnotationTypeMemberDeclaration value) declaration(value, value.getName(), value.resolveBinding(), "method");
        else if (node instanceof PackageDeclaration value) packageDeclaration(value);
        else if (node instanceof MethodDeclaration value) declaration(value, value.getName(), value.resolveBinding(), value.isConstructor() ? "constructor" : "method");
        else if (node instanceof VariableDeclarationFragment value) declaration(value, value.getName(), value.resolveBinding(), value.getParent() instanceof FieldDeclaration ? "field" : "variable");
        else if (node instanceof SingleVariableDeclaration value) declaration(value, value.getName(), value.resolveBinding(), "parameter");
        else if (node instanceof EnumConstantDeclaration value) declaration(value, value.getName(), value.resolveVariable(), "field");
      } catch (IOException error) { throw new BatchWriteException(error); }
    }
    @Override public boolean visit(PackageDeclaration node) {
      // The package name is represented as nested SimpleName nodes. It is one
      // declaration, not a reference occurrence for every qualified segment.
      return false;
    }
    @Override public boolean visit(SimpleName name) {
      try {
        IBinding binding = name.resolveBinding();
        if (binding == null) { counter.unresolved++; return true; }
        if (!name.isDeclaration()) occurrence(name, binding, "reference");
      } catch (IOException error) { throw new BatchWriteException(error); }
      return true;
    }
    @Override public boolean visit(MethodInvocation node) { call(node, node.resolveMethodBinding()); return true; }
    @Override public boolean visit(SuperMethodInvocation node) { call(node, node.resolveMethodBinding()); return true; }
    @Override public boolean visit(ClassInstanceCreation node) { call(node, node.resolveConstructorBinding()); return true; }
    @Override public boolean visit(ConstructorInvocation node) { call(node, node.resolveConstructorBinding()); return true; }
    @Override public boolean visit(SuperConstructorInvocation node) { call(node, node.resolveConstructorBinding()); return true; }
    @Override public boolean visit(ExpressionMethodReference node) { call(node, node.resolveMethodBinding()); return true; }
    @Override public boolean visit(TypeMethodReference node) { call(node, node.resolveMethodBinding()); return true; }
    @Override public boolean visit(SuperMethodReference node) { call(node, node.resolveMethodBinding()); return true; }
    @Override public boolean visit(CreationReference node) { call(node, node.resolveMethodBinding()); return true; }

    private void declaration(ASTNode declaration, SimpleName name, IBinding binding, String declarationKind) throws IOException {
      if (binding == null) { counter.unresolved++; return; }
      Map<String,Object> value = fact("declaration", declaration, binding,
          map("declarationKind", declarationKind, "name", name.getIdentifier()));
      int selectionStart = name.getStartPosition(), selectionEnd = selectionStart + name.getLength();
      value.put("selectionStartLine", Math.max(0, unit.getLineNumber(selectionStart) - 1));
      value.put("selectionStartCharacter", Math.max(0, unit.getColumnNumber(selectionStart)));
      value.put("selectionEndLine", Math.max(0, unit.getLineNumber(selectionEnd) - 1));
      value.put("selectionEndCharacter", Math.max(0, unit.getColumnNumber(selectionEnd)));
      write(writer, value);
      counter.declarations++;
      if (binding instanceof ITypeBinding type) {
        ITypeBinding superclass = type.getSuperclass();
        if (superclass != null) typeEdge(name, binding, superclass, "extends");
        for (ITypeBinding iface : type.getInterfaces()) typeEdge(name, binding, iface, "implements");
      } else if (binding instanceof IMethodBinding method && !method.isConstructor()) {
        methodOverrideEdges(name, method);
      }
    }
    private void packageDeclaration(PackageDeclaration declaration) throws IOException {
      Name name = declaration.getName();
      IBinding binding = declaration.resolveBinding();
      if (binding == null) { counter.unresolved++; return; }
      Map<String,Object> value = fact("declaration", declaration, binding,
          map("declarationKind", "package", "name", name.getFullyQualifiedName()));
      int selectionStart = name.getStartPosition(), selectionEnd = selectionStart + name.getLength();
      value.put("selectionStartLine", Math.max(0, unit.getLineNumber(selectionStart) - 1));
      value.put("selectionStartCharacter", Math.max(0, unit.getColumnNumber(selectionStart)));
      value.put("selectionEndLine", Math.max(0, unit.getLineNumber(selectionEnd) - 1));
      value.put("selectionEndCharacter", Math.max(0, unit.getColumnNumber(selectionEnd)));
      write(writer, value);
      counter.declarations++;
    }
    private static boolean noExplicitConstructor(MethodDeclaration[] methods) {
      for (MethodDeclaration method : methods) if (method.isConstructor()) return false;
      return true;
    }
    private void implicitConstructor(ASTNode declaration, SimpleName name, ITypeBinding type) throws IOException {
      if (type == null) return;
      for (IMethodBinding method : type.getDeclaredMethods()) {
        if (!method.isConstructor() || method.getParameterTypes().length != 0) continue;
        Map<String,Object> value = fact("declaration", declaration, method,
            map("declarationKind", "constructor", "name", name.getIdentifier(), "implicit", true));
        int selectionStart = name.getStartPosition(), selectionEnd = selectionStart + name.getLength();
        value.put("selectionStartLine", Math.max(0, unit.getLineNumber(selectionStart) - 1));
        value.put("selectionStartCharacter", Math.max(0, unit.getColumnNumber(selectionStart)));
        value.put("selectionEndLine", Math.max(0, unit.getLineNumber(selectionEnd) - 1));
        value.put("selectionEndCharacter", Math.max(0, unit.getColumnNumber(selectionEnd)));
        write(writer, value); counter.declarations++;
        return;
      }
    }
    private void occurrence(SimpleName name, IBinding binding, String role) throws IOException {
      write(writer, fact("occurrence", name, binding, map("role", role)));
      counter.occurrences++;
    }
    private void call(ASTNode node, IMethodBinding binding) {
      try {
        if (binding == null) { counter.unresolved++; return; }
        Map<String,Object> fact = location("call", node);
        fact.put("targetKey", binding.getMethodDeclaration().getKey());
        fact.put("targetPortableKey", portable(binding));
        write(writer, fact); counter.calls++;
      } catch (IOException error) { throw new BatchWriteException(error); }
    }
    private void typeEdge(SimpleName node, IBinding source, ITypeBinding target, String relation) throws IOException {
      Map<String,Object> fact = location("typeEdge", node);
      fact.put("sourceKey", source.getKey()); fact.put("sourcePortableKey", portable(source));
      fact.put("targetKey", target.getTypeDeclaration().getKey()); fact.put("targetPortableKey", portable(target));
      fact.put("relation", relation); write(writer, fact); counter.typeEdges++;
    }
    private void methodOverrideEdges(SimpleName node, IMethodBinding source) throws IOException {
      ITypeBinding declaringType = source.getDeclaringClass();
      if (declaringType == null) return;
      Set<String> visitedTypes = new HashSet<>();
      List<ITypeBinding> pending = new ArrayList<>();
      if (declaringType.getSuperclass() != null) pending.add(declaringType.getSuperclass());
      for (ITypeBinding iface : declaringType.getInterfaces()) pending.add(iface);
      while (!pending.isEmpty()) {
        ITypeBinding type = pending.remove(pending.size() - 1);
        String typeKey = portable(type);
        if (!visitedTypes.add(typeKey)) continue;
        for (IMethodBinding candidate : type.getDeclaredMethods()) {
          try {
            if (source.overrides(candidate)) bindingEdge(node, source, candidate, "overrides");
          } catch (RuntimeException ignored) {
            // Recovered bindings can be incomplete. Other resolved supertypes
            // must still be inspected and emitted.
          }
        }
        if (type.getSuperclass() != null) pending.add(type.getSuperclass());
        for (ITypeBinding iface : type.getInterfaces()) pending.add(iface);
      }
    }
    private void bindingEdge(SimpleName node, IBinding source, IBinding target, String relation) throws IOException {
      Map<String,Object> fact = location("typeEdge", node);
      fact.put("sourceKey", source.getKey()); fact.put("sourcePortableKey", portable(source));
      fact.put("targetKey", target.getKey()); fact.put("targetPortableKey", portable(target));
      fact.put("relation", relation); write(writer, fact); counter.typeEdges++;
    }
    private Map<String,Object> fact(String kind, ASTNode node, IBinding target, Map<String,Object> extra) {
      Map<String,Object> fact = location(kind, node);
      fact.put("targetKey", target.getKey()); fact.put("targetPortableKey", portable(target)); fact.putAll(extra);
      return fact;
    }
    private Map<String,Object> location(String kind, ASTNode node) {
      int start = node.getStartPosition(), end = start + node.getLength();
      return map("kind", kind, "uri", uri, "start", start, "length", node.getLength(),
          "startLine", Math.max(0, unit.getLineNumber(start) - 1),
          "startCharacter", Math.max(0, unit.getColumnNumber(start)),
          "endLine", Math.max(0, unit.getLineNumber(end) - 1),
          "endCharacter", Math.max(0, unit.getColumnNumber(end)));
    }
  }

  private static String portable(IBinding binding) {
    // Recovered compiler bindings can expose a method/variable while one of
    // its component bindings is absent. Preserve the enclosing fact with an
    // explicit unresolved component instead of dropping the whole document.
    if (binding == null) return "JDT:<unresolved>";
    if (binding instanceof ITypeBinding type) {
      ITypeBinding value = type.getTypeDeclaration();
      String binary = value.getBinaryName();
      return "T:" + (binary == null ? value.getQualifiedName() : binary);
    }
    if (binding instanceof IMethodBinding method) {
      IMethodBinding value = method.getMethodDeclaration();
      StringBuilder key = new StringBuilder(portable(value.getDeclaringClass())).append('#').append(value.getName()).append('(');
      for (ITypeBinding parameter : value.getParameterTypes()) key.append(portable(parameter)).append(';');
      return key.append(')').append(portable(value.getReturnType())).toString();
    }
    if (binding instanceof IVariableBinding variable && variable.isField()) {
      IVariableBinding value = variable.getVariableDeclaration();
      return portable(value.getDeclaringClass()) + "#" + value.getName() + ":" + portable(value.getType());
    }
    return "JDT:" + binding.getKey();
  }

  private static String sourceUri(ICompilationUnit source) {
    IResource resource = source.getResource();
    URI location = resource == null ? null : resource.getLocationURI();
    return location == null ? source.getPath().toFile().toURI().toString() : location.toString();
  }
  private static void atomicMove(Path from, Path to) throws IOException {
    try { Files.move(from, to, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
    catch (AtomicMoveNotSupportedException ignored) { Files.move(from, to, StandardCopyOption.REPLACE_EXISTING); }
  }
  private static String sha256(Path path) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (var input = Files.newInputStream(path)) { byte[] bytes = new byte[64 * 1024]; for (int read; (read = input.read(bytes)) >= 0;) digest.update(bytes, 0, read); }
    return HexFormat.of().formatHex(digest.digest());
  }
  private static void write(BufferedWriter writer, Map<String,Object> value) throws IOException { writer.write(json(value)); writer.newLine(); }
  private static Map<String,Object> map(Object... pairs) { Map<String,Object> result = new LinkedHashMap<>(); for (int i=0;i<pairs.length;i+=2) result.put(String.valueOf(pairs[i]), pairs[i+1]); return result; }
  private static String json(Object value) {
    if (value == null) return "null";
    if (value instanceof Number || value instanceof Boolean) return value.toString();
    if (value instanceof Map<?,?> map) { StringBuilder out = new StringBuilder("{"); boolean first=true; for (var entry:map.entrySet()) { if(!first)out.append(','); first=false; out.append(json(String.valueOf(entry.getKey()))).append(':').append(json(entry.getValue())); } return out.append('}').toString(); }
    String text=String.valueOf(value); StringBuilder out=new StringBuilder("\""); for(char c:text.toCharArray()){ switch(c){case '\\'->out.append("\\\\");case '"'->out.append("\\\"");case '\n'->out.append("\\n");case '\r'->out.append("\\r");case '\t'->out.append("\\t");default->out.append(c);} } return out.append('"').toString();
  }
  private static final class Counter {
    int documents, declarations, occurrences, calls, typeEdges, unresolved, failedDocuments;
    String firstError;
  }
  private static final class BatchWriteException extends RuntimeException { BatchWriteException(IOException cause) { super(cause); } }
}
