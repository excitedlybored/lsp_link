package io.gitnexus.sootup;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.jar.JarFile;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import sootup.core.jimple.common.expr.AbstractInvokeExpr;
import sootup.core.jimple.common.expr.JDynamicInvokeExpr;
import sootup.core.jimple.common.expr.JInterfaceInvokeExpr;
import sootup.core.jimple.common.expr.JSpecialInvokeExpr;
import sootup.core.jimple.common.expr.JStaticInvokeExpr;
import sootup.core.jimple.common.expr.JVirtualInvokeExpr;
import sootup.core.jimple.common.stmt.InvokableStmt;
import sootup.core.jimple.common.stmt.Stmt;
import sootup.core.model.ClassModifier;
import sootup.core.model.FieldModifier;
import sootup.core.model.MethodModifier;
import sootup.core.model.SourceType;
import sootup.core.inputlocation.AnalysisInputLocation;
import sootup.core.signatures.MethodSignature;
import sootup.core.types.ArrayType;
import sootup.core.types.ClassType;
import sootup.core.types.PrimitiveType;
import sootup.core.types.Type;
import sootup.core.types.VoidType;
import sootup.java.bytecode.frontend.inputlocation.JavaClassPathAnalysisInputLocation;
import sootup.java.core.AnnotationUsage;
import sootup.java.core.JavaSootClass;
import sootup.java.core.JavaSootField;
import sootup.java.core.JavaSootMethod;
import sootup.java.core.views.JavaView;

/** Persistent SootUp worker. Jimple is consumed transiently and never serialized. */
public final class SootUpWorker {
  private static final int PROTOCOL_VERSION = 1;
  private static final int MAX_FACTS = 500;
  private static final int MAX_BYTES = 1024 * 1024;
  private static final Gson GSON = new Gson();

  private final BufferedWriter output = new BufferedWriter(
      new OutputStreamWriter(System.out, StandardCharsets.UTF_8));
  private ExecutorService executor;

  public static void main(String[] args) throws Exception { new SootUpWorker().run(); }

  private void run() throws Exception {
    try (BufferedReader input = new BufferedReader(
        new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
      String line;
      while ((line = input.readLine()) != null) {
        if (line.isBlank()) continue;
        JsonObject request = GSON.fromJson(line, JsonObject.class);
        String type = string(request, "type", "");
        if ("hello".equals(type)) {
          if (integer(request, "protocolVersion", -1) != PROTOCOL_VERSION) {
            emitError(null, "protocol", "Unsupported protocol version", true);
            continue;
          }
          int concurrency = Math.max(1, Math.min(16, integer(request, "concurrency", 4)));
          if (executor == null) executor = Executors.newFixedThreadPool(concurrency);
          emit(Map.of(
              "type", "hello", "protocolVersion", PROTOCOL_VERSION,
              "provider", "sootup", "providerVersion", "2.0.0",
              "javaVersion", System.getProperty("java.version"),
              "runtimeMajor", Runtime.version().feature(),
              "minimumClassFileMajor", 45, "maximumClassFileMajor", 70,
              "concurrency", concurrency));
        } else if ("analyzeArtifact".equals(type)) {
          if (executor == null) throw new IllegalStateException("hello must precede analysis");
          executor.submit(() -> analyze(request));
        } else if ("shutdown".equals(type)) {
          if (executor != null) {
            executor.shutdown();
            executor.awaitTermination(1, TimeUnit.HOURS);
          }
          emit(Map.of("type", "shutdown"));
          return;
        } else {
          emitError(null, "protocol", "Unknown request type: " + type, true);
        }
      }
    }
  }

  private void analyze(JsonObject request) {
    String artifactId = string(request, "artifactId", "");
    try {
      Path jar = Path.of(string(request, "jarPath", "")).toAbsolutePath().normalize();
      Set<String> selected = new TreeSet<>(strings(request, "selectedClasses"));
      boolean analyzeAll = bool(request, "analyzeAll", selected.isEmpty());
      boolean emitClassFacts = bool(request, "emitClassFacts", true);
      boolean emitSelectedClassFacts = bool(request, "emitSelectedClassFacts", false);
      boolean emitCalls = bool(request, "emitCalls", true);
      List<AnalysisInputLocation> locations = new ArrayList<>();
      locations.add(new JavaClassPathAnalysisInputLocation(jar.toString(), SourceType.Application));
      List<String> classpathEntries = strings(request, "classpathEntries").stream()
          .map(entry -> Path.of(entry).toAbsolutePath().normalize().toString())
          .filter(entry -> !entry.equals(jar.toString()))
          .toList();
      if (!classpathEntries.isEmpty()) {
        locations.add(new JavaClassPathAnalysisInputLocation(
            String.join(System.getProperty("path.separator"), classpathEntries), SourceType.Library));
      }
      JavaView view = new JavaView(locations);
      Set<String> primaryClasses = jarClasses(jar);
      List<JavaSootClass> classes = primaryClasses.stream()
          .map(name -> {
            var type = view.getIdentifierFactory().getClassType(name);
            return view.getClass(type).or(() -> view.getAnnotationClass(type));
          })
          .flatMap(java.util.Optional::stream)
          .sorted(Comparator.comparing(clazz -> clazz.getType().getFullyQualifiedName()))
          .toList();
      Batch batch = new Batch(artifactId);
      int classCount = 0;
      int errors = 0;
      for (JavaSootClass clazz : classes) {
        String binaryName = clazz.getType().getFullyQualifiedName();
        boolean detailed = analyzeAll || selected.contains(binaryName);
        if (!emitClassFacts && !detailed) continue;
        try {
          if (emitClassFacts || (emitSelectedClassFacts && detailed)) {
            batch.add(classFact(artifactId, clazz, detailed));
          }
          if (detailed) emitMembers(batch, artifactId, clazz, emitCalls);
          classCount++;
        } catch (Throwable error) {
          errors++;
          emitError(artifactId, "class", binaryName + ": " + concise(error), false);
        }
      }
      batch.flush();
      emit(Map.of(
          "type", "artifactComplete", "artifactId", artifactId,
          "sequence", batch.sequence, "classCount", classCount, "errorCount", errors));
    } catch (Throwable error) {
      try { emitError(artifactId, "artifact", concise(error), true); }
      catch (Exception writeError) { writeError.printStackTrace(System.err); }
    }
  }

  private void emitMembers(
      Batch batch, String artifactId, JavaSootClass clazz, boolean emitCalls
  ) throws Exception {
    List<JavaSootField> fields = clazz.getFields().stream()
        .sorted(Comparator.comparing(field -> field.getSignature().toString())).toList();
    for (int index = 0; index < fields.size(); index++) {
      JavaSootField field = fields.get(index);
      Map<String, Object> fact = base("field", artifactId);
      fact.put("owner", clazz.getType().getFullyQualifiedName());
      fact.put("name", field.getName());
      fact.put("descriptor", descriptor(field.getType()));
      fact.put("access", modifiers(field.getModifiers()));
      fact.put("ordinal", index);
      fact.put("annotations", annotations(field.getAnnotations()));
      fact.put("annotationValues", annotationValues(field.getAnnotations()));
      batch.add(fact);
    }
    List<JavaSootMethod> methods = clazz.getMethods().stream()
        .sorted(Comparator.comparing(method -> method.getSignature().toString())).toList();
    for (int index = 0; index < methods.size(); index++) {
      JavaSootMethod method = methods.get(index);
      Map<String, Object> fact = base("method", artifactId);
      fact.put("owner", clazz.getType().getFullyQualifiedName());
      fact.put("name", method.getName());
      fact.put("descriptor", descriptor(method.getSignature()));
      fact.put("access", modifiers(method.getModifiers()));
      fact.put("hasCode", method.hasBody());
      fact.put("ordinal", index);
      fact.put("annotations", annotations(method.getAnnotations()));
      fact.put("annotationValues", annotationValues(method.getAnnotations()));
      batch.add(fact);
      if (!emitCalls || !method.hasBody()) continue;
      int callOrdinal = 0;
      for (Stmt statement : method.getBody().getStmts()) {
        if (!(statement instanceof InvokableStmt invokable) || !invokable.containsInvokeExpr()) continue;
        AbstractInvokeExpr invoke = invokable.getInvokeExpr().orElseThrow();
        MethodSignature target = invoke.getMethodSignature();
        Map<String, Object> call = base("call", artifactId);
        call.put("owner", clazz.getType().getFullyQualifiedName());
        call.put("methodName", method.getName());
        call.put("methodDescriptor", descriptor(method.getSignature()));
        call.put("instructionOrdinal", callOrdinal);
        call.put("bytecodeOffset", callOrdinal);
        call.put("opcode", dispatch(invoke));
        call.put("targetOwner", target.getDeclClassType().getFullyQualifiedName());
        call.put("targetName", target.getName());
        call.put("targetDescriptor", descriptor(target));
        batch.add(call);
        callOrdinal++;
      }
    }
  }

  private static Map<String, Object> classFact(
      String artifactId, JavaSootClass clazz, boolean detailed
  ) {
    Map<String, Object> fact = base("class", artifactId);
    fact.put("binaryName", clazz.getType().getFullyQualifiedName());
    fact.put("classFileMajor", 0);
    String superName = clazz.getSuperclass().map(ClassType::getFullyQualifiedName).orElse(null);
    fact.put("kind", clazz.isAnnotation() ? "annotation" : clazz.isEnum() ? "enum"
        : clazz.isInterface() ? "interface" : "java.lang.Record".equals(superName) ? "record" : "class");
    fact.put("access", modifiers(clazz.getModifiers()));
    fact.put("superName", superName);
    fact.put("interfaces", clazz.getInterfaces().stream()
        .map(ClassType::getFullyQualifiedName).sorted().toList());
    fact.put("annotations", annotations(clazz.getAnnotations()));
    fact.put("annotationValues", annotationValues(clazz.getAnnotations()));
    fact.put("detailed", detailed);
    return fact;
  }

  private static String descriptor(MethodSignature signature) {
    StringBuilder result = new StringBuilder("(");
    for (Type parameter : signature.getParameterTypes()) result.append(descriptor(parameter));
    return result.append(')').append(descriptor(signature.getType())).toString();
  }

  private static String descriptor(Type type) {
    if (type instanceof VoidType) return "V";
    if (type instanceof ArrayType array) {
      return "[".repeat(array.getDimension()) + descriptor(array.getBaseType());
    }
    if (type instanceof ClassType clazz) {
      return "L" + clazz.getFullyQualifiedName().replace('.', '/') + ";";
    }
    if (type instanceof PrimitiveType primitive) return switch (primitive.getName()) {
      case "boolean" -> "Z"; case "byte" -> "B"; case "char" -> "C";
      case "short" -> "S"; case "int" -> "I"; case "long" -> "J";
      case "float" -> "F"; case "double" -> "D";
      default -> throw new IllegalArgumentException("Unknown primitive " + primitive);
    };
    throw new IllegalArgumentException("Unsupported type " + type);
  }

  private static String dispatch(AbstractInvokeExpr invoke) {
    if (invoke instanceof JStaticInvokeExpr) return "invokestatic";
    if (invoke instanceof JInterfaceInvokeExpr) return "invokeinterface";
    if (invoke instanceof JSpecialInvokeExpr) return "invokespecial";
    if (invoke instanceof JVirtualInvokeExpr) return "invokevirtual";
    if (invoke instanceof JDynamicInvokeExpr) return "invokedynamic";
    return "invoke";
  }

  private static List<String> annotations(Iterable<AnnotationUsage> values) {
    List<String> result = new ArrayList<>();
    for (AnnotationUsage value : values) {
      result.add(value.getAnnotation().getFullyQualifiedName());
    }
    result.sort(String::compareTo);
    return result;
  }

  private static Map<String, String> annotationValues(Iterable<AnnotationUsage> values) {
    Map<String, String> result = new LinkedHashMap<>();
    for (AnnotationUsage value : values) {
      result.put(value.getAnnotation().getFullyQualifiedName(), GSON.toJson(value.getValues()));
    }
    return result;
  }

  private static String modifiers(Iterable<?> modifiers) {
    List<String> names = new ArrayList<>();
    for (Object modifier : modifiers) names.add(modifier.toString().toLowerCase());
    names.sort(String::compareTo);
    return String.join(" ", names);
  }

  private static Map<String, Object> base(String factType, String artifactId) {
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("factType", factType);
    result.put("artifactId", artifactId);
    return result;
  }

  private final class Batch {
    final String artifactId;
    final List<Map<String, Object>> facts = new ArrayList<>();
    int estimatedBytes;
    long sequence;
    Batch(String artifactId) { this.artifactId = artifactId; }
    void add(Map<String, Object> fact) throws Exception {
      int bytes = GSON.toJson(fact).getBytes(StandardCharsets.UTF_8).length;
      if (bytes > MAX_BYTES - 1024) throw new IllegalStateException("single fact exceeds limit");
      if (!facts.isEmpty() && (facts.size() >= MAX_FACTS || estimatedBytes + bytes > MAX_BYTES - 1024)) flush();
      facts.add(fact);
      estimatedBytes += bytes;
    }
    void flush() throws Exception {
      if (facts.isEmpty()) return;
      emit(Map.of("type", "batch", "contractVersion", 1,
          "artifactId", artifactId, "sequence", sequence, "facts", List.copyOf(facts)));
      facts.clear();
      estimatedBytes = 0;
      sequence++;
    }
  }

  private synchronized void emit(Map<String, ?> value) throws Exception {
    output.write(GSON.toJson(value));
    output.newLine();
    output.flush();
  }

  private void emitError(String artifactId, String scope, String message, boolean fatal) throws Exception {
    Map<String, Object> value = new LinkedHashMap<>();
    value.put("type", "error");
    if (artifactId != null) value.put("artifactId", artifactId);
    value.put("scope", scope); value.put("message", message); value.put("fatal", fatal);
    emit(value);
  }

  private static String string(JsonObject value, String name, String fallback) {
    JsonElement element = value.get(name);
    return element == null || element.isJsonNull() ? fallback : element.getAsString();
  }
  private static int integer(JsonObject value, String name, int fallback) {
    JsonElement element = value.get(name);
    return element == null || element.isJsonNull() ? fallback : element.getAsInt();
  }
  private static boolean bool(JsonObject value, String name, boolean fallback) {
    JsonElement element = value.get(name);
    return element == null || element.isJsonNull() ? fallback : element.getAsBoolean();
  }
  private static List<String> strings(JsonObject value, String name) {
    JsonArray array = value.getAsJsonArray(name);
    if (array == null) return List.of();
    List<String> result = new ArrayList<>();
    for (JsonElement item : array) result.add(item.getAsString());
    return result;
  }
  private static Set<String> jarClasses(Path jar) throws Exception {
    Set<String> result = new HashSet<>();
    try (JarFile file = new JarFile(jar.toFile())) {
      file.stream().filter(entry -> !entry.isDirectory())
          .map(entry -> entry.getName())
          .filter(name -> name.endsWith(".class") && !name.startsWith("META-INF/versions/"))
          .map(name -> name.substring(0, name.length() - 6).replace('/', '.'))
          .forEach(result::add);
    }
    return result;
  }
  private static String concise(Throwable error) {
    return error.getClass().getSimpleName()
        + (error.getMessage() == null ? "" : ": " + error.getMessage());
  }
}
