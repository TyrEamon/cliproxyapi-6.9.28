#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const { Readable } = require("node:stream");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT, "bin");
const DEFAULT_RELEASE_REPO = "router-for-me/CLIProxyAPI";
const BINARY_NAME = process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
const BINARY_PATH = path.join(BIN_DIR, BINARY_NAME);

function log(message) {
  console.log(`[galaxy-start] ${message}`);
}

function warn(message) {
  console.warn(`[galaxy-start] ${message}`);
}

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function parsePort(value, label) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid ${label} value: ${value}`);
  }
  return port;
}

function isMyIpRouteEnabled() {
  return envFlag("CLIPROXY_ENABLE_MY_IP_ROUTE", false)
    || envFlag("ENABLE_MY_IP_ROUTE", false)
    || envFlag("CLIPROXY_MY_IP_ONLY", false);
}

function isMyIpOnlyMode() {
  if (envFlag("CLIPROXY_ENABLE_MY_IP_ROUTE", false) || envFlag("ENABLE_MY_IP_ROUTE", false)) {
    return false;
  }
  return envFlag("CLIPROXY_MY_IP_ONLY", false);
}

function envValue(...names) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw != null && raw.trim() !== "") {
      return raw.trim();
    }
  }
  return "";
}

function isGitStoreEnabled() {
  return envValue("GITSTORE_GIT_URL", "gitstore_git_url") !== "";
}

function runtimePorts() {
  const publicPort = parsePort(process.env.PORT || process.env.CLIPROXY_PORT || "8317", "PORT");
  if (!isMyIpRouteEnabled()) {
    return { publicPort, appPort: publicPort };
  }

  const defaultInternalPort = publicPort === 65535 ? 8317 : publicPort + 1;
  const appPort = parsePort(process.env.CLIPROXY_INTERNAL_PORT || String(defaultInternalPort), "CLIPROXY_INTERNAL_PORT");
  if (appPort === publicPort) {
    throw new Error("CLIPROXY_INTERNAL_PORT must be different from PORT when /my-ip route is enabled");
  }
  return { publicPort, appPort };
}

function splitList(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function renderList(key, values) {
  if (!values.length) {
    return `${key}: []`;
  }
  return `${key}:\n${values.map((value) => `  - ${yamlString(value)}`).join("\n")}`;
}

function renderGeneratedConfig({ port, authDir, apiKeys, allowRemoteManagement }) {
  return [
    'host: ""',
    `port: ${port}`,
    `auth-dir: ${yamlString(authDir)}`,
    renderList("api-keys", apiKeys),
    "remote-management:",
    `  allow-remote: ${allowRemoteManagement ? "true" : "false"}`,
    '  secret-key: ""',
    "logging-to-file: false",
    "usage-statistics-enabled: false",
    "",
  ].join("\n");
}

function upsertTopLevelScalar(yaml, key, value) {
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:.*$`, "m");
  if (pattern.test(yaml)) {
    return yaml.replace(pattern, line);
  }
  return `${line}\n${yaml}`;
}

function upsertTopLevelList(yaml, key, values) {
  if (!values.length) {
    return yaml;
  }

  const block = renderList(key, values).split("\n");
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${key}:` || line.startsWith(`${key}: `));

  if (start === -1) {
    if (yaml.endsWith("\n")) {
      return `${yaml}${block.join("\n")}\n`;
    }
    return `${yaml}\n${block.join("\n")}\n`;
  }

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "" || line.startsWith(" ") || line.startsWith("\t") || line.trim().startsWith("- ")) {
      end++;
      continue;
    }
    break;
  }

  lines.splice(start, end - start, ...block);
  return lines.join("\n");
}

function upsertRemoteAllow(yaml, allowRemoteManagement) {
  if (!envFlag("ALLOW_REMOTE_MANAGEMENT", false)) {
    return yaml;
  }

  const value = allowRemoteManagement ? "true" : "false";
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "remote-management:");
  if (start === -1) {
    return `${yaml.replace(/\s*$/, "\n")}remote-management:\n  allow-remote: ${value}\n`;
  }

  let end = start + 1;
  let allowIndex = -1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("\t")) {
      break;
    }
    if (/^\s+allow-remote:/.test(line)) {
      allowIndex = end;
    }
    end++;
  }

  if (allowIndex !== -1) {
    lines[allowIndex] = `  allow-remote: ${value}`;
  } else {
    lines.splice(start + 1, 0, `  allow-remote: ${value}`);
  }
  return lines.join("\n");
}

function ensureLocalConfig(port) {
  const configPath = path.resolve(ROOT, process.env.CLIPROXY_CONFIG_PATH || "config.yaml");
  const authDir = process.env.CLIPROXY_AUTH_DIR || "auths";
  const apiKeys = splitList(process.env.API_KEYS || process.env.CLIPROXY_API_KEYS);
  const allowRemoteManagement = envFlag("ALLOW_REMOTE_MANAGEMENT", Boolean(process.env.MANAGEMENT_PASSWORD));

  let yaml;
  if (process.env.CLIPROXY_CONFIG_BASE64) {
    yaml = Buffer.from(process.env.CLIPROXY_CONFIG_BASE64, "base64").toString("utf8");
  } else if (process.env.CLIPROXY_CONFIG_YAML) {
    yaml = process.env.CLIPROXY_CONFIG_YAML;
  } else if (fs.existsSync(configPath)) {
    yaml = fs.readFileSync(configPath, "utf8");
  } else {
    yaml = renderGeneratedConfig({ port, authDir, apiKeys, allowRemoteManagement });
  }

  yaml = upsertTopLevelScalar(yaml, "port", String(port));
  if (!/^\s*auth-dir:/m.test(yaml)) {
    yaml = upsertTopLevelScalar(yaml, "auth-dir", yamlString(authDir));
  }
  yaml = upsertTopLevelList(yaml, "api-keys", apiKeys);
  yaml = upsertRemoteAllow(yaml, allowRemoteManagement);

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, yaml.endsWith("\n") ? yaml : `${yaml}\n`);

  if (!apiKeys.length && !/^\s*api-keys:\s*\n\s*-/m.test(yaml)) {
    warn("no API_KEYS/CLIPROXY_API_KEYS configured; API routes may be unauthenticated.");
  }

  log(`using config ${path.relative(ROOT, configPath)} on port ${port}`);
  return configPath;
}

function resolveConfigPath(port, checkOnly) {
  if (isGitStoreEnabled()) {
    log("using git-backed storage from GITSTORE_GIT_URL; skipping local config.yaml generation");
    return "";
  }

  if (checkOnly) {
    warn("GITSTORE_GIT_URL is not configured; check mode will not generate local config.yaml");
    return "";
  }

  if (!envFlag("CLIPROXY_ALLOW_LOCAL_CONFIG", false)) {
    throw new Error("GITSTORE_GIT_URL is required for Galaxy git-backed storage; set CLIPROXY_ALLOW_LOCAL_CONFIG=true to use local config.yaml");
  }

  return ensureLocalConfig(port);
}

function platformAssetName(version) {
  if (process.platform !== "linux") {
    throw new Error(`Galaxy launcher downloads Linux releases only; current platform is ${process.platform}`);
  }

  const archMap = {
    x64: "amd64",
    arm64: "aarch64",
  };
  const releaseArch = archMap[process.arch];
  if (!releaseArch) {
    throw new Error(`unsupported CPU architecture: ${process.arch}`);
  }

  const cleanVersion = version.replace(/^v/i, "");
  return `CLIProxyAPI_${cleanVersion}_linux_${releaseArch}.tar.gz`;
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "cliproxyapi-galaxy-launcher",
      "Accept": "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function resolveDownload() {
  if (process.env.CLIPROXY_BINARY_URL) {
    return {
      url: process.env.CLIPROXY_BINARY_URL,
      version: "custom",
      assetName: path.basename(new URL(process.env.CLIPROXY_BINARY_URL).pathname),
    };
  }

  const repo = process.env.CLIPROXY_RELEASE_REPO || DEFAULT_RELEASE_REPO;
  const version = process.env.CLIPROXY_VERSION;
  const apiUrl = version
    ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(version)}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const release = await githubJson(apiUrl);
  const tag = release.tag_name || version;
  const assetName = platformAssetName(tag);
  const asset = (release.assets || []).find((item) => item.name === assetName);
  if (!asset) {
    throw new Error(`release ${tag} does not contain ${assetName}`);
  }

  return { url: asset.browser_download_url, version: tag, assetName };
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url, {
    headers: { "User-Agent": "cliproxyapi-galaxy-launcher" },
  });
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error("download response did not include a body");
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const file = fs.createWriteStream(outputPath);
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(response.body);
    stream.on("error", reject);
    stream.pipe(file);
    file.on("finish", resolve);
    file.on("error", reject);
  });
}

function findExtractedBinary(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findExtractedBinary(fullPath);
      if (found) {
        return found;
      }
      continue;
    }
    if (entry.isFile() && (entry.name === "cli-proxy-api" || entry.name === "CLIProxyAPI")) {
      return fullPath;
    }
  }
  return "";
}

async function ensureBinary() {
  if (fs.existsSync(BINARY_PATH) && !envFlag("CLIPROXY_FORCE_DOWNLOAD", false)) {
    return BINARY_PATH;
  }

  const tarCheck = spawnSync("tar", ["--version"], { stdio: "ignore" });
  if (tarCheck.error || tarCheck.status !== 0) {
    throw new Error("the system tar command is required to extract CLIProxyAPI releases");
  }

  const download = await resolveDownload();
  log(`downloading ${download.assetName} from ${download.version}`);

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cliproxyapi-"));
  const archivePath = path.join(tempDir, download.assetName);
  await downloadFile(download.url, archivePath);

  const extract = spawnSync("tar", ["-xzf", archivePath, "-C", tempDir], { stdio: "inherit" });
  if (extract.error) {
    throw extract.error;
  }
  if (extract.status !== 0) {
    throw new Error(`tar exited with status ${extract.status}`);
  }

  const extractedBinary = findExtractedBinary(tempDir);
  if (!extractedBinary) {
    throw new Error("release archive did not contain cli-proxy-api binary");
  }

  fs.copyFileSync(extractedBinary, BINARY_PATH);
  fs.chmodSync(BINARY_PATH, 0o755);
  return BINARY_PATH;
}

function runtimeEnv(appPort) {
  const env = {
    ...process.env,
    PORT: String(appPort),
    CLIPROXY_PORT: String(appPort),
    DEPLOY: process.env.DEPLOY || "cloud",
  };

  if (isGitStoreEnabled() && !envValue("GITSTORE_LOCAL_PATH", "gitstore_local_path")) {
    env.GITSTORE_LOCAL_PATH = path.join(os.tmpdir(), "cliproxyapi-gitstore");
  }

  return env;
}

function startBinary(binaryPath, configPath, appPort) {
  const args = configPath ? ["-config", configPath] : [];
  const child = spawn(binaryPath, args, {
    cwd: ROOT,
    env: runtimeEnv(appPort),
    stdio: "inherit",
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      log(`CLIProxyAPI stopped by ${signal}`);
      process.exit(0);
    }
    process.exit(code || 0);
  });

  return child;
}

function proxyHeaders(request, appPort) {
  const headers = { ...request.headers };
  for (const header of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete headers[header];
  }

  const remoteAddress = request.socket.remoteAddress;
  if (remoteAddress) {
    headers["x-forwarded-for"] = headers["x-forwarded-for"]
      ? `${headers["x-forwarded-for"]}, ${remoteAddress}`
      : remoteAddress;
  }
  headers["x-forwarded-host"] = request.headers.host || "";
  headers.host = `127.0.0.1:${appPort}`;
  return headers;
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

async function handleMyIp(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const ipResponse = await fetch("https://api.ipify.org?format=json", {
      signal: controller.signal,
      headers: { "User-Agent": "cliproxyapi-galaxy-launcher" },
    });
    const text = await ipResponse.text();
    if (!ipResponse.ok) {
      sendJson(response, 502, {
        error: "ip lookup failed",
        status: ipResponse.status,
        body: text.slice(0, 200),
      });
      return;
    }

    const parsed = JSON.parse(text);
    sendJson(response, 200, {
      ip: parsed.ip,
      source: "api.ipify.org",
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    sendJson(response, 502, { error: error.message });
  } finally {
    clearTimeout(timeout);
  }
}

function proxyRequest(request, response, appPort, options = {}) {
  if (options.myIpOnly) {
    sendJson(response, 404, { error: "only /my-ip is enabled in CLIPROXY_MY_IP_ONLY mode" });
    return;
  }

  const proxy = http.request(
    {
      hostname: "127.0.0.1",
      port: appPort,
      path: request.url,
      method: request.method,
      headers: proxyHeaders(request, appPort),
    },
    (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode || 502, proxyResponse.statusMessage, proxyResponse.headers);
      proxyResponse.pipe(response);
    },
  );

  proxy.on("error", (error) => {
    if (!response.headersSent) {
      sendJson(response, 502, { error: "upstream unavailable", message: error.message });
      return;
    }
    response.destroy(error);
  });

  request.pipe(proxy);
}

function startMyIpFrontProxy(publicPort, appPort, options = {}) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname === "/my-ip") {
      handleMyIp(request, response);
      return;
    }
    proxyRequest(request, response, appPort, options);
  });

  server.on("upgrade", (request, socket) => {
    socket.destroy();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 65000;

  server.listen(publicPort, "0.0.0.0", () => {
    log(`front proxy listening on ${publicPort}; forwarding app traffic to 127.0.0.1:${appPort}`);
    log("temporary /my-ip route enabled");
  });
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const myIpOnly = isMyIpOnlyMode();
  const ports = runtimePorts();
  const configPath = resolveConfigPath(ports.appPort, checkOnly);

  if (checkOnly) {
    log("launcher check completed");
    return;
  }

  if (myIpOnly) {
    log("CLIPROXY_MY_IP_ONLY enabled; skipping CLIProxyAPI binary startup");
    startMyIpFrontProxy(ports.publicPort, ports.appPort, { myIpOnly: true });
    return;
  }

  const binaryPath = await ensureBinary();
  startBinary(binaryPath, configPath, ports.appPort);
  if (isMyIpRouteEnabled()) {
    startMyIpFrontProxy(ports.publicPort, ports.appPort);
  }
}

main().catch((error) => {
  console.error(`[galaxy-start] ${error.stack || error.message}`);
  process.exit(1);
});
