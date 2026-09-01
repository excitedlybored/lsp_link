import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { globSync } from 'glob';

const repository = path.resolve(import.meta.dirname, '..');
const plugins = path.join(repository, 'vendor/jdtls/1.57.0/plugins');
const sourceRoot = path.join(repository, 'jdt_batch_extension/src');
const outputRoot = path.join(repository, 'dist/jdt-batch-extension');
const classes = path.join(outputRoot, 'classes');
const bundle = path.join(outputRoot, 'gitnexus-jdt-batch-extension.jar');
const required = ['org.eclipse.jdt.ls.core_', 'org.eclipse.jdt.core_', 'org.eclipse.core.runtime_',
  'org.eclipse.core.resources_', 'org.eclipse.core.jobs_', 'org.eclipse.core.contenttype_',
  'org.eclipse.equinox.common_', 'org.eclipse.osgi_', 'org.eclipse.lsp4j_'];
const jars = required.map((prefix) => {
  const matches = globSync(path.join(plugins, `${prefix}*.jar`)).sort();
  if (matches.length !== 1) throw new Error(`Expected one ${prefix} JAR, found ${matches.length}`);
  return matches[0];
});
const javaHome = process.env.GITNEXUS_JDT_JAVA_HOME || process.env.JAVA_HOME;
const executable = (name) => {
  if (javaHome) return path.join(javaHome, 'bin', name);
  const candidates = [
    ...globSync(`/usr/lib/jvm/*/bin/${name}`),
    ...globSync(`/opt/homebrew/opt/openjdk@21/bin/${name}`),
    ...globSync(path.join(process.env.HOME ?? '', `.local/jdks/*/bin/${name}`)),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? name;
};
const sources = globSync(path.join(sourceRoot, '**/*.java')).sort();
fs.rmSync(classes, { recursive: true, force: true });
fs.mkdirSync(classes, { recursive: true });
execFileSync(executable('javac'), ['--release', '21', '-cp', jars.join(path.delimiter), '-d', classes, ...sources], { stdio: 'inherit' });
fs.copyFileSync(path.join(repository, 'jdt_batch_extension/plugin.xml'), path.join(classes, 'plugin.xml'));
execFileSync(executable('jar'), ['--create', '--file', bundle, '--manifest', path.join(repository, 'jdt_batch_extension/META-INF/MANIFEST.MF'), '-C', classes, '.'], { stdio: 'inherit' });
console.log(`Built ${bundle}`);
