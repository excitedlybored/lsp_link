package io.gitnexus.artifact;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.jar.Attributes;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.objectweb.asm.AnnotationVisitor;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.FieldVisitor;
import org.objectweb.asm.Handle;
import org.objectweb.asm.Label;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;

/** Persistent, classloading-free ASM worker speaking versioned NDJSON. */
public final class ArtifactWorker {
  private static final int PROTOCOL_VERSION = 1;
  private static final int MAX_FACTS = 500;
  private static final int MAX_BYTES = 1024 * 1024;

  private final BufferedWriter output = new BufferedWriter(
      new OutputStreamWriter(System.out, StandardCharsets.UTF_8));
  private ExecutorService executor;
  private JarCache jarCache;

  public static void main(String[] args) throws Exception {
    new ArtifactWorker().run();
  }

  private void run() throws Exception {
    try (BufferedReader input = new BufferedReader(
        new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
      String line;
      while ((line = input.readLine()) != null) {
        if (line.isBlank()) continue;
        String type = Json.string(line, "type");
        if ("hello".equals(type)) {
          int requestedProtocol = Json.integer(line, "protocolVersion", -1);
          if (requestedProtocol != PROTOCOL_VERSION) {
            emitError(null, "protocol", "Unsupported protocol version " + requestedProtocol, true);
            continue;
          }
          int concurrency = Math.max(1, Math.min(16, Json.integer(line, "concurrency", 4)));
          if (executor == null) {
            executor = Executors.newFixedThreadPool(concurrency);
            jarCache = new JarCache(concurrency);
          }
          emit(Map.of(
              "type", "hello",
              "protocolVersion", PROTOCOL_VERSION,
              "provider", "asm",
              "providerVersion", "9.9.1",
              "javaVersion", System.getProperty("java.version"),
              "runtimeMajor", Runtime.version().feature(),
              "minimumClassFileMajor", 45,
              "maximumClassFileMajor", 70,
              "concurrency", concurrency));
        } else if ("analyzeArtifact".equals(type)) {
          if (executor == null) throw new IllegalStateException("hello must precede artifact requests");
          String request = line;
          executor.submit(() -> {
            try { analyze(request); }
            catch (Throwable error) {
              try { emitError(Json.string(request, "artifactId"), "worker", concise(error), true); }
              catch (Exception writeError) { writeError.printStackTrace(System.err); }
            }
          });
        } else if ("shutdown".equals(type)) {
          if (executor != null) {
            executor.shutdown();
            executor.awaitTermination(1, TimeUnit.HOURS);
          }
          if (jarCache != null) jarCache.close();
          emit(Map.of("type", "shutdown"));
          return;
        } else {
          emitError(null, "protocol", "Unknown request type: " + type, true);
        }
      }
    }
  }

  private void analyze(String request) throws Exception {
    String artifactId = Json.string(request, "artifactId");
    String jarPath = Json.string(request, "jarPath");
    int runtimeMajor = Json.integer(request, "runtimeMajor", Runtime.version().feature());
    Set<String> selected = new TreeSet<>(Json.stringArray(request, "selectedClasses"));
    boolean analyzeAll = Json.bool(request, "analyzeAll", selected.isEmpty());
    boolean emitClassFacts = Json.bool(request, "emitClassFacts", true);
    boolean emitSelectedClassFacts = Json.bool(request, "emitSelectedClassFacts", false);
    long sequence = 0;
    long emittedBatches = 0;
    Batch batch = new Batch(artifactId, sequence);
    int classes = 0;
    int errors = 0;
    try (JarLease lease = jarCache.acquire(Path.of(jarPath))) {
      JarFile jar = lease.jar;
      Map<String, JarEntry> entries = effectiveClasses(jar, runtimeMajor);
      for (Map.Entry<String, JarEntry> item : entries.entrySet()) {
        String binaryName = item.getKey().substring(0, item.getKey().length() - 6).replace('/', '.');
        boolean detailed = analyzeAll || selected.contains(binaryName);
        if (!emitClassFacts && !detailed) continue;
        try {
          byte[] bytes = jar.getInputStream(item.getValue()).readAllBytes();
          ClassFacts facts = new ClassFacts(
              artifactId, binaryName, detailed, emitClassFacts || (emitSelectedClassFacts && detailed),
              detailed ? BytecodeOffsets.read(bytes) : Map.of());
          new ClassReader(bytes).accept(facts, ClassReader.SKIP_FRAMES);
          for (Map<String, Object> fact : facts.facts) {
            if (!batch.add(fact)) {
              if (batch.facts.isEmpty()) throw new IllegalStateException("single ASM fact exceeds protocol limit");
              emit(batch.message());
              emittedBatches++;
              batch = new Batch(artifactId, ++sequence);
              if (!batch.add(fact)) throw new IllegalStateException("single ASM fact exceeds protocol limit");
            }
          }
          classes += 1;
        } catch (Throwable error) {
          errors += 1;
          emitError(artifactId, "class", binaryName + ": " + concise(error), false);
        }
      }
      if (!batch.facts.isEmpty()) {
        emit(batch.message());
        emittedBatches++;
      }
      emit(Map.of(
          "type", "artifactComplete",
          "artifactId", artifactId,
          "sequence", emittedBatches,
          "classCount", classes,
          "errorCount", errors));
    } catch (Throwable error) {
      emitError(artifactId, "artifact", concise(error), true);
    }
  }

  private static Map<String, JarEntry> effectiveClasses(JarFile jar, int runtimeMajor) throws Exception {
    boolean multiRelease = jar.getManifest() != null
        && "true".equalsIgnoreCase(jar.getManifest().getMainAttributes()
            .getValue(Attributes.Name.MULTI_RELEASE));
    Map<String, VersionedEntry> selected = new TreeMap<>();
    var entries = jar.entries();
    while (entries.hasMoreElements()) {
      JarEntry entry = entries.nextElement();
      if (entry.isDirectory() || !entry.getName().endsWith(".class")) continue;
      String logical = entry.getName();
      int version = 0;
      if (logical.startsWith("META-INF/versions/")) {
        if (!multiRelease) continue;
        String remainder = logical.substring("META-INF/versions/".length());
        int slash = remainder.indexOf('/');
        if (slash < 1) continue;
        try { version = Integer.parseInt(remainder.substring(0, slash)); }
        catch (NumberFormatException ignored) { continue; }
        if (version > runtimeMajor) continue;
        logical = remainder.substring(slash + 1);
      } else if (logical.startsWith("META-INF/")) {
        continue;
      }
      if (logical.endsWith("module-info.class") || logical.endsWith("package-info.class")) continue;
      VersionedEntry current = selected.get(logical);
      if (current == null || version > current.version) selected.put(logical, new VersionedEntry(version, entry));
    }
    Map<String, JarEntry> result = new LinkedHashMap<>();
    selected.forEach((name, value) -> result.put(name, value.entry));
    return result;
  }

  private void emitError(String artifactId, String scope, String message, boolean fatal) throws Exception {
    Map<String, Object> value = new LinkedHashMap<>();
    value.put("type", "error");
    if (artifactId != null) value.put("artifactId", artifactId);
    value.put("scope", scope);
    value.put("message", message);
    value.put("fatal", fatal);
    emit(value);
  }

  private synchronized void emit(Map<String, ?> value) throws Exception {
    output.write(Json.write(value));
    output.newLine();
    output.flush();
  }

  private static String concise(Throwable error) {
    String message = error.getMessage();
    return error.getClass().getSimpleName() + (message == null ? "" : ": " + message);
  }

  private record VersionedEntry(int version, JarEntry entry) {}

  /** Access-ordered, reference-counted cache that never exceeds worker concurrency. */
  private static final class JarCache implements AutoCloseable {
    private final int maximum;
    private final LinkedHashMap<Path, CachedJar> entries = new LinkedHashMap<>(16, 0.75f, true);

    JarCache(int maximum) { this.maximum = maximum; }

    synchronized JarLease acquire(Path requested) throws Exception {
      Path path = requested.toAbsolutePath().normalize();
      for (;;) {
        CachedJar current = entries.get(path);
        if (current != null) {
          current.references++;
          return new JarLease(this, path, current.jar);
        }
        if (entries.size() < maximum || evictOne()) {
          CachedJar created = new CachedJar(new JarFile(path.toFile(), false));
          created.references = 1;
          entries.put(path, created);
          return new JarLease(this, path, created.jar);
        }
        wait();
      }
    }

    private boolean evictOne() throws Exception {
      var iterator = entries.entrySet().iterator();
      while (iterator.hasNext()) {
        var candidate = iterator.next();
        if (candidate.getValue().references != 0) continue;
        iterator.remove();
        candidate.getValue().jar.close();
        return true;
      }
      return false;
    }

    synchronized void release(Path path) {
      CachedJar cached = entries.get(path);
      if (cached != null) cached.references--;
      notifyAll();
    }

    @Override public synchronized void close() throws Exception {
      for (CachedJar cached : entries.values()) cached.jar.close();
      entries.clear();
    }
  }

  private static final class CachedJar {
    final JarFile jar;
    int references;
    CachedJar(JarFile jar) { this.jar = jar; }
  }

  private static final class JarLease implements AutoCloseable {
    final JarCache cache;
    final Path path;
    final JarFile jar;
    boolean closed;
    JarLease(JarCache cache, Path path, JarFile jar) {
      this.cache = cache; this.path = path; this.jar = jar;
    }
    @Override public void close() {
      if (closed) return;
      closed = true;
      cache.release(path);
    }
  }

  private static final class Batch {
    final String artifactId;
    final long sequence;
    final List<Map<String, Object>> facts = new ArrayList<>();
    int estimatedBytes;

    Batch(String artifactId, long sequence) {
      this.artifactId = artifactId;
      this.sequence = sequence;
    }

    boolean add(Map<String, Object> fact) {
      int bytes = Json.write(fact).getBytes(StandardCharsets.UTF_8).length;
      if (bytes > MAX_BYTES - 1024) return false;
      if (!facts.isEmpty() && (facts.size() >= MAX_FACTS || estimatedBytes + bytes > MAX_BYTES - 1024)) return false;
      facts.add(fact);
      estimatedBytes += bytes;
      return true;
    }

    Map<String, Object> message() {
      return Map.of("type", "batch", "contractVersion", 1,
          "artifactId", artifactId, "sequence", sequence, "facts", facts);
    }
  }

  private static final class ClassFacts extends ClassVisitor {
    final String artifactId;
    final String requestedBinaryName;
    final Map<String, Object> clazz = new LinkedHashMap<>();
    final List<Map<String, Object>> facts = new ArrayList<>();
    final List<String> classAnnotations = new ArrayList<>();
    final Map<String, String> classAnnotationValues = new LinkedHashMap<>();
    final boolean detailed;
    final boolean emitClassFact;
    String binaryName;
    String classKey;
    int methodOrdinal;
    int fieldOrdinal;
    final Map<String, int[]> invocationOffsets;

    ClassFacts(String artifactId, String requestedBinaryName, boolean detailed, boolean emitClassFact,
        Map<String, int[]> invocationOffsets) {
      super(Opcodes.ASM9);
      this.artifactId = artifactId;
      this.requestedBinaryName = requestedBinaryName;
      this.detailed = detailed;
      this.emitClassFact = emitClassFact;
      this.invocationOffsets = invocationOffsets;
    }

    @Override public void visit(int version, int access, String name, String signature,
        String superName, String[] interfaces) {
      binaryName = dotted(name);
      classKey = binaryName;
      clazz.put("factType", "class");
      clazz.put("artifactId", artifactId);
      clazz.put("binaryName", binaryName);
      clazz.put("classFileMajor", version & 0xffff);
      clazz.put("kind", classKind(access));
      clazz.put("access", accessString(access));
      clazz.put("superName", dotted(superName));
      clazz.put("interfaces", interfaces == null ? List.of() : Arrays.stream(interfaces).map(ClassFacts::dotted).toList());
      clazz.put("annotations", classAnnotations);
      clazz.put("annotationValues", classAnnotationValues);
      clazz.put("detailed", detailed);
      if (emitClassFact) facts.add(clazz);
    }

    @Override public AnnotationVisitor visitAnnotation(String descriptor, boolean visible) {
      return captureAnnotation(classAnnotations, classAnnotationValues, descriptor);
    }

    @Override public FieldVisitor visitField(int access, String name, String descriptor,
        String signature, Object value) {
      if (!detailed) return null;
      Map<String, Object> field = new LinkedHashMap<>();
      List<String> annotations = new ArrayList<>();
      Map<String, String> annotationValues = new LinkedHashMap<>();
      field.put("factType", "field");
      field.put("artifactId", artifactId);
      field.put("owner", binaryName);
      field.put("name", name);
      field.put("descriptor", descriptor);
      field.put("access", accessString(access));
      field.put("ordinal", fieldOrdinal++);
      field.put("annotations", annotations);
      field.put("annotationValues", annotationValues);
      facts.add(field);
      return new FieldVisitor(Opcodes.ASM9) {
        @Override public AnnotationVisitor visitAnnotation(String annotationDescriptor, boolean visible) {
          return captureAnnotation(annotations, annotationValues, annotationDescriptor);
        }
      };
    }

    @Override public MethodVisitor visitMethod(int access, String name, String descriptor,
        String signature, String[] exceptions) {
      if (!detailed) return null;
      Map<String, Object> method = new LinkedHashMap<>();
      List<String> annotations = new ArrayList<>();
      Map<String, String> annotationValues = new LinkedHashMap<>();
      int ordinal = methodOrdinal++;
      method.put("factType", "method");
      method.put("artifactId", artifactId);
      method.put("owner", binaryName);
      method.put("name", name);
      method.put("descriptor", descriptor);
      method.put("access", accessString(access));
      method.put("hasCode", false);
      method.put("ordinal", ordinal);
      method.put("annotations", annotations);
      method.put("annotationValues", annotationValues);
      facts.add(method);
      int[] bytecodeOffsets = invocationOffsets.getOrDefault(name + descriptor, new int[0]);
      return new MethodVisitor(Opcodes.ASM9) {
        int instructionOrdinal;

        @Override public AnnotationVisitor visitAnnotation(String annotationDescriptor, boolean visible) {
          return captureAnnotation(annotations, annotationValues, annotationDescriptor);
        }

        @Override public void visitCode() { method.put("hasCode", true); }

        @Override public void visitMethodInsn(int opcode, String owner, String targetName,
            String targetDescriptor, boolean isInterface) {
          addCall(opcodeName(opcode), dotted(owner), targetName, targetDescriptor, instructionOrdinal++);
        }

        @Override public void visitInvokeDynamicInsn(String targetName, String targetDescriptor,
            Handle bootstrapMethodHandle, Object... bootstrapMethodArguments) {
          addCall("invokedynamic", dotted(bootstrapMethodHandle.getOwner()), targetName,
              targetDescriptor, instructionOrdinal++);
        }

        private void addCall(String opcode, String targetOwner, String targetName,
            String targetDescriptor, int callOrdinal) {
          if (callOrdinal >= bytecodeOffsets.length) {
            throw new IllegalStateException("ASM invocation count exceeds parsed bytecode offsets for "
                + binaryName + "." + name + descriptor);
          }
          Map<String, Object> call = new LinkedHashMap<>();
          call.put("factType", "call");
          call.put("artifactId", artifactId);
          call.put("owner", binaryName);
          call.put("methodName", name);
          call.put("methodDescriptor", descriptor);
          call.put("instructionOrdinal", callOrdinal);
          call.put("bytecodeOffset", bytecodeOffsets[callOrdinal]);
          call.put("opcode", opcode);
          call.put("targetOwner", targetOwner);
          call.put("targetName", targetName);
          call.put("targetDescriptor", targetDescriptor);
          facts.add(call);
        }
      };
    }

    private static void addAnnotation(List<String> annotations, String descriptor) {
      String name = Type.getType(descriptor).getClassName();
      if (!annotations.contains(name)) annotations.add(name);
    }

    private static AnnotationVisitor captureAnnotation(
        List<String> annotations, Map<String, String> annotationValues, String descriptor) {
      String annotationName = Type.getType(descriptor).getClassName();
      if (!annotations.contains(annotationName)) annotations.add(annotationName);
      Map<String, Object> values = new LinkedHashMap<>();
      return valueVisitor(values, () -> annotationValues.put(annotationName, Json.write(values)));
    }

    private static AnnotationVisitor valueVisitor(Map<String, Object> values, Runnable completed) {
      return new AnnotationVisitor(Opcodes.ASM9) {
        @Override public void visit(String name, Object value) {
          values.put(name, annotationValue(value));
        }

        @Override public void visitEnum(String name, String descriptor, String value) {
          values.put(name, Type.getType(descriptor).getClassName() + "#" + value);
        }

        @Override public AnnotationVisitor visitAnnotation(String name, String descriptor) {
          Map<String, Object> nested = new LinkedHashMap<>();
          values.put(name, nested);
          return valueVisitor(nested, () -> {});
        }

        @Override public AnnotationVisitor visitArray(String name) {
          List<Object> entries = new ArrayList<>();
          values.put(name, entries);
          return arrayVisitor(entries);
        }

        @Override public void visitEnd() { completed.run(); }
      };
    }

    private static AnnotationVisitor arrayVisitor(List<Object> values) {
      return new AnnotationVisitor(Opcodes.ASM9) {
        @Override public void visit(String name, Object value) {
          values.add(annotationValue(value));
        }

        @Override public void visitEnum(String name, String descriptor, String value) {
          values.add(Type.getType(descriptor).getClassName() + "#" + value);
        }

        @Override public AnnotationVisitor visitAnnotation(String name, String descriptor) {
          Map<String, Object> nested = new LinkedHashMap<>();
          values.add(nested);
          return valueVisitor(nested, () -> {});
        }

        @Override public AnnotationVisitor visitArray(String name) {
          List<Object> nested = new ArrayList<>();
          values.add(nested);
          return arrayVisitor(nested);
        }
      };
    }

    private static Object annotationValue(Object value) {
      if (value instanceof Type type) return type.getClassName();
      if (value instanceof byte[] array) {
        List<Integer> result = new ArrayList<>(array.length);
        for (byte item : array) result.add((int) item);
        return result;
      }
      if (value instanceof boolean[] array) {
        List<Boolean> result = new ArrayList<>(array.length);
        for (boolean item : array) result.add(item);
        return result;
      }
      if (value instanceof short[] array) {
        List<Integer> result = new ArrayList<>(array.length);
        for (short item : array) result.add((int) item);
        return result;
      }
      if (value instanceof char[] array) {
        List<String> result = new ArrayList<>(array.length);
        for (char item : array) result.add(String.valueOf(item));
        return result;
      }
      if (value instanceof int[] array) return Arrays.stream(array).boxed().toList();
      if (value instanceof long[] array) return Arrays.stream(array).boxed().toList();
      if (value instanceof float[] array) {
        List<Float> result = new ArrayList<>(array.length);
        for (float item : array) result.add(item);
        return result;
      }
      if (value instanceof double[] array) return Arrays.stream(array).boxed().toList();
      return value;
    }

    private static String classKind(int access) {
      if ((access & Opcodes.ACC_ANNOTATION) != 0) return "annotation";
      if ((access & Opcodes.ACC_ENUM) != 0) return "enum";
      if ((access & Opcodes.ACC_RECORD) != 0) return "record";
      if ((access & Opcodes.ACC_INTERFACE) != 0) return "interface";
      return "class";
    }

    private static String accessString(int access) {
      List<String> values = new ArrayList<>();
      if ((access & Opcodes.ACC_PUBLIC) != 0) values.add("public");
      if ((access & Opcodes.ACC_PROTECTED) != 0) values.add("protected");
      if ((access & Opcodes.ACC_PRIVATE) != 0) values.add("private");
      if ((access & Opcodes.ACC_STATIC) != 0) values.add("static");
      if ((access & Opcodes.ACC_FINAL) != 0) values.add("final");
      if ((access & Opcodes.ACC_ABSTRACT) != 0) values.add("abstract");
      if ((access & Opcodes.ACC_NATIVE) != 0) values.add("native");
      if ((access & Opcodes.ACC_SYNCHRONIZED) != 0) values.add("synchronized");
      if ((access & Opcodes.ACC_VOLATILE) != 0) values.add("volatile");
      if ((access & Opcodes.ACC_TRANSIENT) != 0) values.add("transient");
      return String.join(" ", values);
    }

    private static String dotted(String value) {
      return value == null ? null : value.replace('/', '.');
    }

    private static String opcodeName(int opcode) {
      return switch (opcode) {
        case Opcodes.INVOKEVIRTUAL -> "invokevirtual";
        case Opcodes.INVOKESPECIAL -> "invokespecial";
        case Opcodes.INVOKESTATIC -> "invokestatic";
        case Opcodes.INVOKEINTERFACE -> "invokeinterface";
        default -> "invoke-" + opcode;
      };
    }
  }

  /** Reads exact invocation byte offsets directly from Code attributes. */
  private static final class BytecodeOffsets {
    static Map<String, int[]> read(byte[] classFile) throws Exception {
      try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(classFile))) {
        if (input.readInt() != 0xCAFEBABE) throw new IllegalArgumentException("invalid class-file magic");
        input.readUnsignedShort();
        input.readUnsignedShort();
        int constantPoolCount = input.readUnsignedShort();
        String[] utf8 = new String[constantPoolCount];
        for (int index = 1; index < constantPoolCount; index++) {
          int tag = input.readUnsignedByte();
          switch (tag) {
            case 1 -> {
              int length = input.readUnsignedShort();
              byte[] encoded = new byte[length + 2];
              encoded[0] = (byte) (length >>> 8);
              encoded[1] = (byte) length;
              byte[] content = input.readNBytes(length);
              if (content.length != length) throw new IllegalArgumentException("truncated UTF-8 constant");
              System.arraycopy(content, 0, encoded, 2, length);
              try (DataInputStream modified = new DataInputStream(new ByteArrayInputStream(encoded))) {
                utf8[index] = modified.readUTF();
              }
            }
            case 3, 4 -> input.skipNBytes(4);
            case 5, 6 -> { input.skipNBytes(8); index++; }
            case 7, 8, 16, 19, 20 -> input.skipNBytes(2);
            case 9, 10, 11, 12, 17, 18 -> input.skipNBytes(4);
            case 15 -> input.skipNBytes(3);
            default -> throw new IllegalArgumentException("unsupported constant-pool tag " + tag);
          }
        }
        input.skipNBytes(6);
        int interfaceCount = input.readUnsignedShort();
        input.skipNBytes(2L * interfaceCount);
        skipMembers(input, input.readUnsignedShort());
        int methodCount = input.readUnsignedShort();
        Map<String, int[]> result = new HashMap<>();
        for (int method = 0; method < methodCount; method++) {
          input.readUnsignedShort();
          String name = utf8[input.readUnsignedShort()];
          String descriptor = utf8[input.readUnsignedShort()];
          int attributeCount = input.readUnsignedShort();
          for (int attribute = 0; attribute < attributeCount; attribute++) {
            String attributeName = utf8[input.readUnsignedShort()];
            int length = input.readInt();
            byte[] value = input.readNBytes(length);
            if (value.length != length) throw new IllegalArgumentException("truncated method attribute");
            if ("Code".equals(attributeName)) {
              try (DataInputStream codeInput = new DataInputStream(new ByteArrayInputStream(value))) {
                codeInput.skipNBytes(4);
                int codeLength = codeInput.readInt();
                byte[] code = codeInput.readNBytes(codeLength);
                if (code.length != codeLength) throw new IllegalArgumentException("truncated Code attribute");
                result.put(name + descriptor, invocationOffsets(code));
              }
            }
          }
        }
        return result;
      }
    }

    private static void skipMembers(DataInputStream input, int count) throws Exception {
      for (int member = 0; member < count; member++) {
        input.skipNBytes(6);
        int attributes = input.readUnsignedShort();
        for (int attribute = 0; attribute < attributes; attribute++) {
          input.skipNBytes(2);
          long length = Integer.toUnsignedLong(input.readInt());
          input.skipNBytes(length);
        }
      }
    }

    private static int[] invocationOffsets(byte[] code) {
      List<Integer> offsets = new ArrayList<>();
      int offset = 0;
      while (offset < code.length) {
        int opcode = code[offset] & 0xff;
        if (opcode >= 182 && opcode <= 186) offsets.add(offset);
        int length = instructionLength(code, offset, opcode);
        if (length < 1 || offset + length > code.length) {
          throw new IllegalArgumentException("invalid bytecode at offset " + offset);
        }
        offset += length;
      }
      return offsets.stream().mapToInt(Integer::intValue).toArray();
    }

    private static int instructionLength(byte[] code, int offset, int opcode) {
      return switch (opcode) {
        case 16, 18, 21, 22, 23, 24, 25, 54, 55, 56, 57, 58, 169, 188 -> 2;
        case 17, 19, 20, 132,
            153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166,
            167, 168, 178, 179, 180, 181, 182, 183, 184, 187, 189, 192, 193,
            198, 199 -> 3;
        case 197 -> 4;
        case 185, 186, 200, 201 -> 5;
        case 170 -> tableSwitchLength(code, offset);
        case 171 -> lookupSwitchLength(code, offset);
        case 196 -> (code[offset + 1] & 0xff) == 132 ? 6 : 4;
        default -> 1;
      };
    }

    private static int tableSwitchLength(byte[] code, int offset) {
      int aligned = (offset + 4) & ~3;
      int low = readInt(code, aligned + 4);
      int high = readInt(code, aligned + 8);
      long entries = (long) high - low + 1;
      long length = aligned - offset + 12L + entries * 4L;
      if (entries < 0 || length > Integer.MAX_VALUE) throw new IllegalArgumentException("invalid tableswitch");
      return (int) length;
    }

    private static int lookupSwitchLength(byte[] code, int offset) {
      int aligned = (offset + 4) & ~3;
      int pairs = readInt(code, aligned + 4);
      long length = aligned - offset + 8L + (long) pairs * 8L;
      if (pairs < 0 || length > Integer.MAX_VALUE) throw new IllegalArgumentException("invalid lookupswitch");
      return (int) length;
    }

    private static int readInt(byte[] value, int offset) {
      if (offset < 0 || offset + 4 > value.length) throw new IllegalArgumentException("truncated switch");
      return (value[offset] & 0xff) << 24 | (value[offset + 1] & 0xff) << 16
          | (value[offset + 2] & 0xff) << 8 | value[offset + 3] & 0xff;
    }
  }

  /** Minimal JSON codec for the deliberately small, controlled protocol. */
  private static final class Json {
    static String string(String json, String key) {
      String marker = "\"" + key + "\"";
      int at = json.indexOf(marker);
      if (at < 0) return null;
      at = json.indexOf(':', at + marker.length()) + 1;
      while (at < json.length() && Character.isWhitespace(json.charAt(at))) at++;
      if (at >= json.length() || json.charAt(at) != '"') return null;
      StringBuilder value = new StringBuilder();
      for (int i = at + 1; i < json.length(); i++) {
        char c = json.charAt(i);
        if (c == '"') return value.toString();
        if (c == '\\' && ++i < json.length()) {
          char escaped = json.charAt(i);
          value.append(switch (escaped) {
            case 'n' -> '\n'; case 'r' -> '\r'; case 't' -> '\t';
            case 'b' -> '\b'; case 'f' -> '\f'; default -> escaped;
          });
        } else value.append(c);
      }
      return null;
    }

    static int integer(String json, String key, int fallback) {
      String marker = "\"" + key + "\"";
      int at = json.indexOf(marker);
      if (at < 0) return fallback;
      at = json.indexOf(':', at + marker.length()) + 1;
      int end = at;
      while (end < json.length() && (Character.isWhitespace(json.charAt(end)) || json.charAt(end) == '-'
          || Character.isDigit(json.charAt(end)))) end++;
      try { return Integer.parseInt(json.substring(at, end).trim()); }
      catch (RuntimeException ignored) { return fallback; }
    }

    static boolean bool(String json, String key, boolean fallback) {
      String marker = "\"" + key + "\"";
      int at = json.indexOf(marker);
      if (at < 0) return fallback;
      at = json.indexOf(':', at + marker.length()) + 1;
      while (at < json.length() && Character.isWhitespace(json.charAt(at))) at++;
      if (json.startsWith("true", at)) return true;
      if (json.startsWith("false", at)) return false;
      return fallback;
    }

    static List<String> stringArray(String json, String key) {
      String marker = "\"" + key + "\"";
      int at = json.indexOf(marker);
      if (at < 0) return List.of();
      int open = json.indexOf('[', at + marker.length());
      int close = open < 0 ? -1 : json.indexOf(']', open + 1);
      if (close < 0) return List.of();
      List<String> values = new ArrayList<>();
      int cursor = open + 1;
      while (cursor < close) {
        int quote = json.indexOf('"', cursor);
        if (quote < 0 || quote >= close) break;
        int end = quote + 1;
        while (end < close) {
          if (json.charAt(end) == '"' && json.charAt(end - 1) != '\\') break;
          end++;
        }
        values.add(json.substring(quote + 1, end).replace("\\\"", "\"").replace("\\\\", "\\"));
        cursor = end + 1;
      }
      return values;
    }

    static String write(Object value) {
      if (value == null) return "null";
      if (value instanceof String string) return quote(string);
      if (value instanceof Number || value instanceof Boolean) return value.toString();
      if (value instanceof Map<?, ?> map) {
        StringBuilder result = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
          if (!first) result.append(',');
          first = false;
          result.append(quote(String.valueOf(entry.getKey()))).append(':').append(write(entry.getValue()));
        }
        return result.append('}').toString();
      }
      if (value instanceof Iterable<?> iterable) {
        StringBuilder result = new StringBuilder("[");
        boolean first = true;
        for (Object item : iterable) {
          if (!first) result.append(',');
          first = false;
          result.append(write(item));
        }
        return result.append(']').toString();
      }
      throw new IllegalArgumentException("Unsupported JSON value: " + value.getClass());
    }

    private static String quote(String value) {
      StringBuilder result = new StringBuilder("\"");
      for (int i = 0; i < value.length(); i++) {
        char c = value.charAt(i);
        switch (c) {
          case '"' -> result.append("\\\"");
          case '\\' -> result.append("\\\\");
          case '\n' -> result.append("\\n");
          case '\r' -> result.append("\\r");
          case '\t' -> result.append("\\t");
          default -> {
            if (c < 0x20) result.append(String.format("\\u%04x", (int)c));
            else result.append(c);
          }
        }
      }
      return result.append('"').toString();
    }
  }
}
