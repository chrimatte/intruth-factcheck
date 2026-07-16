import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const SECRET_ASSIGNMENT = /\b(?:ANTHROPIC|DEEPGRAM|SERPER)(?:_API)?_?KEY\s*=\s*(["'`])([^"'`]+)\1/gi;

export async function walkFiles(root, predicate = () => true) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(absolute, predicate));
    } else if (predicate(absolute)) {
      files.push(absolute);
    }
  }
  return files;
}

export function collectManifestReferences(manifest) {
  const refs = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.length > 0) refs.add(value);
  };

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  Object.values(manifest.action?.default_icon ?? {}).forEach(add);
  Object.values(manifest.icons ?? {}).forEach(add);
  for (const contentScript of manifest.content_scripts ?? []) {
    (contentScript.js ?? []).forEach(add);
    (contentScript.css ?? []).forEach(add);
  }
  for (const resourceGroup of manifest.web_accessible_resources ?? []) {
    (resourceGroup.resources ?? []).forEach(add);
  }

  return [...refs];
}

export function extractLocalHtmlReferences(html) {
  const refs = [];
  const attributePattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    const value = match[1];
    if (!value || value.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) continue;
    refs.push(value.split(/[?#]/, 1)[0]);
  }
  return refs;
}

export function findHardcodedProviderSecrets(source) {
  return [...source.matchAll(SECRET_ASSIGNMENT)]
    .map((match) => match[2].trim())
    .filter(Boolean);
}

export async function validateExtension(extensionRoot) {
  const errors = [];
  const manifestPath = path.join(extensionRoot, "manifest.json");
  let manifest;

  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return [`manifest.json is not valid JSON: ${error.message}`];
  }

  if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");
  if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version ?? "")) errors.push("manifest version is invalid");
  if (!manifest.minimum_chrome_version) errors.push("minimum_chrome_version must be explicit");
  for (const pattern of manifest.host_permissions ?? []) {
    if (/^wss?:\/\//i.test(pattern)) {
      errors.push(`WebSocket schemes are invalid manifest match patterns; use the equivalent HTTP(S) origin: ${pattern}`);
    }
  }

  const referenced = collectManifestReferences(manifest);
  const htmlQueue = new Set(await walkFiles(extensionRoot, (file) => file.endsWith(".html")));
  for (const relative of referenced) {
    const absolute = path.resolve(extensionRoot, relative);
    if (!absolute.startsWith(path.resolve(extensionRoot) + path.sep)) {
      errors.push(`manifest reference escapes extension root: ${relative}`);
      continue;
    }
    try {
      if (!(await stat(absolute)).isFile()) errors.push(`manifest reference is not a file: ${relative}`);
      if (absolute.endsWith(".html")) htmlQueue.add(absolute);
    } catch {
      errors.push(`missing manifest reference: ${relative}`);
    }
  }

  for (const htmlPath of htmlQueue) {
    const html = await readFile(htmlPath, "utf8");
    for (const relative of extractLocalHtmlReferences(html)) {
      const absolute = path.resolve(path.dirname(htmlPath), relative);
      if (!absolute.startsWith(path.resolve(extensionRoot) + path.sep)) {
        errors.push(`HTML reference escapes extension root: ${path.relative(extensionRoot, absolute)}`);
        continue;
      }
      try {
        if (!(await stat(absolute)).isFile()) errors.push(`missing HTML reference: ${path.relative(extensionRoot, absolute)}`);
      } catch {
        errors.push(`missing HTML reference: ${path.relative(extensionRoot, absolute)}`);
      }
    }
  }

  const scripts = await walkFiles(extensionRoot, (file) => file.endsWith(".js"));
  for (const script of scripts) {
    const secrets = findHardcodedProviderSecrets(await readFile(script, "utf8"));
    if (secrets.length > 0) errors.push(`hard-coded provider credential in ${path.relative(extensionRoot, script)}`);
  }

  return errors;
}
