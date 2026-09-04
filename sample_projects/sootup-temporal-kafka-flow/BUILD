load("@rules_java//java:defs.bzl", "java_library")

java_library(
    name = "framework_api_stubs",
    srcs = glob(["src/main/java/io/**/*.java", "src/main/java/org/**/*.java"]),
)

java_library(
    name = "flow",
    srcs = glob(["src/main/java/example/**/*.java"]),
    deps = [":framework_api_stubs"],
)
