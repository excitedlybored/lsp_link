load("@rules_java//java:defs.bzl", PublicJavaInfo = "JavaInfo")
load("@rules_java//java/private:java_info.bzl", PrivateJavaInfo = "JavaInfo")

GitNexusJavaGraphInfo = provider(fields = ["manifests", "artifacts"])

def _gitnexus_source_aspect_impl(target, ctx):
    sources = []
    dependencies = []
    transitive_manifests = []
    transitive_artifacts = []
    if hasattr(ctx.rule.attr, "srcs"):
        for source_target in ctx.rule.attr.srcs:
            for source in source_target.files.to_list():
                sources.append({"path": source.path, "shortPath": source.short_path, "isSource": source.is_source})
    for attribute in ["deps", "exports", "runtime_deps", "plugins"]:
        if hasattr(ctx.rule.attr, attribute):
            for dependency in getattr(ctx.rule.attr, attribute):
                dependencies.append({"label": str(dependency.label), "attribute": attribute})
                if GitNexusJavaGraphInfo in dependency:
                    transitive_manifests.append(dependency[GitNexusJavaGraphInfo].manifests)
                    transitive_artifacts.append(dependency[GitNexusJavaGraphInfo].artifacts)
    direct_artifacts = []
    compile_jars = []
    runtime_jars = []
    source_jars = []
    java_info = None
    if PublicJavaInfo in target:
        java_info = target[PublicJavaInfo]
    elif PrivateJavaInfo in target:
        java_info = target[PrivateJavaInfo]
    has_java_info = java_info != None
    if has_java_info:
        compile_jars = java_info.compile_jars.to_list()
        runtime_jars = list(java_info.runtime_output_jars)
        source_jars = list(java_info.source_jars)
        direct_artifacts = compile_jars + runtime_jars + source_jars
    output = ctx.actions.declare_file(ctx.label.name + ".gitnexus-sources.json")
    ctx.actions.write(output, json.encode({
        "label": str(ctx.label),
        "ruleKind": ctx.rule.kind,
        "hasJavaInfo": has_java_info,
        "sources": sources,
        "dependencies": dependencies,
        "compileArtifacts": [artifact.path for artifact in compile_jars],
        "runtimeArtifacts": [artifact.path for artifact in runtime_jars],
        "sourceJars": [artifact.path for artifact in source_jars],
    }))
    manifests = depset(direct = [output], transitive = transitive_manifests)
    artifacts = depset(direct = direct_artifacts, transitive = transitive_artifacts)
    return [
        GitNexusJavaGraphInfo(manifests = manifests, artifacts = artifacts),
        OutputGroupInfo(gitnexus_source_manifest = manifests, gitnexus_java_artifacts = artifacts),
    ]

gitnexus_source_aspect = aspect(
    implementation = _gitnexus_source_aspect_impl,
    attr_aspects = ["deps", "exports", "runtime_deps", "plugins"],
)
