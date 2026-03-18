import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CanvasState = {
  process: ChildProcess | null;
  port: number | null;
  starting: Promise<string> | null;
};

const state: CanvasState = {
  process: null,
  port: null,
  starting: null,
};

const HOST = "127.0.0.1";
const BASE_PORT = 19274;
const BROWSER_CLIENT_HINT = "Open the reported canvas URL in a browser pane and keep that page connected before using screenshot or viewport tools.";

function getSourceDir() {
  const __filename = fileURLToPath(import.meta.url);
  return path.dirname(__filename);
}

function getPackageRoot() {
  return path.resolve(getSourceDir(), "..");
}
function getCanvasServerPath() {
  return path.join(getPackageRoot(), "vendor", "mcp_excalidraw", "dist", "server.js");
}
function getCanvasWorkingDir() {
  return path.join(getPackageRoot(), "vendor", "mcp_excalidraw");
}

function isProcessAlive(proc: ChildProcess | null) {
  return !!proc && proc.exitCode === null && !proc.killed;
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = createServer();
    testServer.once("error", () => resolve(false));
    testServer.once("listening", () => {
      testServer.close(() => resolve(true));
    });
    testServer.listen(port, HOST);
  });
}

async function findAvailablePort(start = BASE_PORT): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No available port found in range ${start}-${start + 99}`);
}

async function waitForHealth(url: string, timeoutMs = 20000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Canvas server did not become healthy within ${timeoutMs}ms`);
}

async function ensureCanvasRunning(ctx?: { ui?: { notify: (msg: string, level: "info" | "success" | "warning" | "error") => void } }): Promise<string> {
  if (state.port && isProcessAlive(state.process)) {
    return `http://localhost:${state.port}`;
  }

  if (state.starting) return state.starting;

  state.starting = (async () => {
    const serverPath = getCanvasServerPath();
    const cwd = getCanvasWorkingDir();

    if (!existsSync(serverPath)) {
      throw new Error(
        `Canvas server not found at ${serverPath}. Reinstall the package or restore the vendored runtime assets under vendor/mcp_excalidraw.`
      );
    }

    const port = await findAvailablePort(BASE_PORT);
    const proc = spawn(process.execPath, [serverPath], {
      cwd,
      env: {
        ...process.env,
        HOST,
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", () => {});
    proc.stderr?.on("data", () => {});

    proc.on("exit", () => {
      state.process = null;
      state.port = null;
    });

    state.process = proc;
    state.port = port;

    const url = `http://localhost:${port}`;
    await waitForHealth(url);

    ctx?.ui?.notify(`Excalidraw canvas running at ${url}`, "success");
    return url;
  })();

  try {
    return await state.starting;
  } finally {
    state.starting = null;
  }
}

async function stopCanvas() {
  const proc = state.process;
  if (!proc) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, 4000);

    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    try {
      proc.kill("SIGTERM");
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });

  state.process = null;
  state.port = null;
}

async function callApi(method: string, route: string, body?: unknown) {
  const url = await ensureCanvasRunning();
  const res = await fetch(`${url}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // ignore
  }

  if (!res.ok) {
    const message = data?.error || `Request failed: ${method} ${route} -> ${res.status}`;
    if (typeof message === "string" && message.includes("No frontend client connected")) {
      throw new Error(`${message} ${BROWSER_CLIENT_HINT}`);
    }
    throw new Error(message);
  }
  return data;
}

function describeElementType(element: any): string {
  if (element?.type === "ellipse") {
    const w = Number(element?.width ?? 0);
    const h = Number(element?.height ?? 0);
    if (Math.abs(w - h) <= 2) return "circle";
    return "ellipse";
  }

  if (element?.type === "rectangle") {
    if (element?.roundness) return "rounded rectangle";
    return "rectangle";
  }

  if (element?.type === "text") return `text${element?.text ? ` — \"${String(element.text)}\"` : ""}`;
  return String(element?.type ?? "unknown");
}

function summarizeElements(result: any): string {
  const elements = Array.isArray(result?.elements) ? result.elements : [];
  if (elements.length === 0) return "Canvas is empty.";

  const lines = elements.map((element: any, index: number) => {
    const label = describeElementType(element);
    return `${index + 1}. ${label} (id: ${element?.id ?? "n/a"})`;
  });

  return `Current canvas elements (${elements.length}):\n${lines.join("\n")}`;
}

function summarizeExport(result: any, format: string): string {
  const dataLength = typeof result?.data === "string" ? result.data.length : 0;
  return `Exported canvas as ${format.toUpperCase()} (${dataLength} bytes of encoded data).`;
}

function summarizeViewport(result: any): string {
  return result?.message ? `Viewport updated: ${result.message}` : "Viewport updated.";
}

const SCENE_BUNDLE_VERSION = 1;
const SCENE_BUNDLE_EXTENSION = ".excalidraw.json";

type BundleKind = "diagram" | "template";

type SceneBundle = {
  version: number;
  kind?: BundleKind;
  name: string;
  slug: string;
  savedAt: string;
  workspaceRoot: string;
  sourcePath: string;
  elementCount: number;
  fileCount: number;
  elements: any[];
  files: any[];
};

type SceneBundleRecord = {
  bundle: SceneBundle;
  bundlePath: string;
};
function getWorkspaceRoot() {
  return process.cwd();
}

function getBundlesDirectory(kind: BundleKind) {
  return path.join(
    getWorkspaceRoot(),
    ".pi",
    kind === "template" ? "excalidraw-templates" : "excalidraw-diagrams",
  );
}

function getBundleNoun(kind: BundleKind) {
  return kind === "template" ? "template" : "diagram";
}

function getBundlePlural(kind: BundleKind) {
  return kind === "template" ? "templates" : "diagrams";
}

function sanitizeBundleName(kind: BundleKind, name: string) {
  const trimmed = String(name || "").trim();
  const noun = getBundleNoun(kind);
  if (!trimmed) throw new Error(`${noun[0].toUpperCase()}${noun.slice(1)} name is required.`);
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return {
    name: trimmed,
    slug: slug || `${kind}-${Date.now().toString(36)}`,
  };
}

function getBundlePath(kind: BundleKind, name: string) {
  const { slug } = sanitizeBundleName(kind, name);
  return path.join(getBundlesDirectory(kind), `${slug}${SCENE_BUNDLE_EXTENSION}`);
}
function toWorkspaceRelativePath(targetPath: string) {
  return path.relative(getWorkspaceRoot(), targetPath) || path.basename(targetPath);
}
function normalizeStoredFiles(rawFiles: unknown): any[] {
  if (Array.isArray(rawFiles)) return rawFiles;
  if (rawFiles && typeof rawFiles === "object") return Object.values(rawFiles as Record<string, unknown>);
  return [];
}

function isSceneBundle(value: unknown): value is SceneBundle {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SceneBundle>;
  return typeof candidate.name === "string"
    && typeof candidate.slug === "string"
    && typeof candidate.savedAt === "string"
    && Array.isArray(candidate.elements)
    && Array.isArray(candidate.files);
}

async function ensureBundlesDirectory(kind: BundleKind) {
  const dir = getBundlesDirectory(kind);
  await mkdir(dir, { recursive: true });
  return dir;
}
async function getCanvasSceneState() {
  const [sceneResult, filesResult] = await Promise.all([
    callApi("GET", "/api/elements"),
    callApi("GET", "/api/files"),
  ]);

  return {
    elements: Array.isArray(sceneResult?.elements) ? sceneResult.elements : [],
    files: normalizeStoredFiles(filesResult?.files),
  };
}

async function writeSceneBundle(kind: BundleKind, name: string) {
  const { name: normalizedName, slug } = sanitizeBundleName(kind, name);
  const { elements, files } = await getCanvasSceneState();
  const dir = await ensureBundlesDirectory(kind);
  const bundlePath = path.join(dir, `${slug}${SCENE_BUNDLE_EXTENSION}`);

  const bundle: SceneBundle = {
    version: SCENE_BUNDLE_VERSION,
    kind,
    name: normalizedName,
    slug,
    savedAt: new Date().toISOString(),
    workspaceRoot: getWorkspaceRoot(),
    sourcePath: toWorkspaceRelativePath(bundlePath),
    elementCount: elements.length,
    fileCount: files.length,
    elements,
    files,
  };
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { bundle, bundlePath };
}

async function readSceneBundle(bundlePath: string, expectedKind?: BundleKind): Promise<SceneBundle> {
  const raw = await readFile(bundlePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isSceneBundle(parsed)) {
    throw new Error(`Saved Excalidraw bundle at ${toWorkspaceRelativePath(bundlePath)} is invalid.`);
  }

  const parsedKind = (parsed as any).kind;
  const normalizedKind = parsedKind === "diagram" || parsedKind === "template"
    ? parsedKind
    : undefined;

  const normalized: SceneBundle = {
    ...parsed,
    version: Number((parsed as any).version ?? SCENE_BUNDLE_VERSION),
    kind: normalizedKind,
    elementCount: Array.isArray(parsed.elements) ? parsed.elements.length : 0,
    fileCount: Array.isArray(parsed.files) ? parsed.files.length : 0,
  };

  if (expectedKind && normalized.kind && normalized.kind !== expectedKind) {
    throw new Error(
      `Expected a ${getBundleNoun(expectedKind)} bundle but found a ${normalized.kind} bundle at ${toWorkspaceRelativePath(bundlePath)}.`
    );
  }

  if (expectedKind && !normalized.kind) {
    const expectedDir = path.resolve(getBundlesDirectory(expectedKind));
    const resolvedPath = path.resolve(bundlePath);
    const inExpectedDir = resolvedPath === expectedDir || resolvedPath.startsWith(`${expectedDir}${path.sep}`);
    if (!inExpectedDir) {
      throw new Error(
        `Saved bundle at ${toWorkspaceRelativePath(bundlePath)} does not declare whether it is a diagram or template. Use a bundle from ${toWorkspaceRelativePath(getBundlesDirectory(expectedKind))}, or re-save it with the current tools.`
      );
    }
  }

  return normalized;
}

async function listSceneBundles(kind: BundleKind) {
  const dir = getBundlesDirectory(kind);
  if (!existsSync(dir)) return [] as SceneBundleRecord[];
  const entries = await readdir(dir, { withFileTypes: true });
  const bundles: SceneBundleRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(SCENE_BUNDLE_EXTENSION)) continue;
    const bundlePath = path.join(dir, entry.name);
    try {
      const bundle = await readSceneBundle(bundlePath, kind);
      bundles.push({ bundle, bundlePath });
    } catch {
      // Skip invalid bundle files so one bad file does not block discovery.
    }
  }
  return bundles.sort((a, b) => Date.parse(b.bundle.savedAt) - Date.parse(a.bundle.savedAt));
}

async function resolveSceneBundle(kind: BundleKind, input: string) {
  const query = String(input || "").trim();
  if (!query) throw new Error(`A saved ${getBundleNoun(kind)} name or path is required.`);

  const candidates = await listSceneBundles(kind);
  const normalizedQuery = query.toLowerCase();
  const directPath = path.isAbsolute(query) ? query : path.join(getWorkspaceRoot(), query);
  if (existsSync(directPath)) {
    return {
      bundle: await readSceneBundle(directPath, kind),
      bundlePath: directPath,
    };
  }
  const matched = candidates.find(({ bundle, bundlePath }) => {
    const relativePath = toWorkspaceRelativePath(bundlePath).toLowerCase();
    const fileName = path.basename(bundlePath).toLowerCase();
    return bundle.name.toLowerCase() === normalizedQuery
      || bundle.slug.toLowerCase() === normalizedQuery
      || relativePath === normalizedQuery
      || fileName === normalizedQuery;
  });
  if (!matched) {
    throw new Error(`Saved ${getBundleNoun(kind)} "${query}" was not found in ${toWorkspaceRelativePath(getBundlesDirectory(kind))}.`);
  }
  return matched;
}

async function replaceCanvasScene(bundle: SceneBundle) {
  const currentFilesResult = await callApi("GET", "/api/files");
  const currentFiles = normalizeStoredFiles(currentFilesResult?.files);
  await callApi("DELETE", "/api/elements/clear");
  for (const file of currentFiles) {
    if (file?.id) {
      try {
        await callApi("DELETE", `/api/files/${encodeURIComponent(String(file.id))}`);
      } catch {
        // Ignore missing/stale file deletions.
      }
    }
  }
  if (bundle.files.length > 0) {
    await callApi("POST", "/api/files", { files: bundle.files });
  }
  if (bundle.elements.length > 0) {
    await createElementsBatch(bundle.elements);
  }
}

function summarizeBundles(kind: BundleKind, items: SceneBundleRecord[]) {
  const directory = toWorkspaceRelativePath(getBundlesDirectory(kind));
  if (items.length === 0) {
    if (kind === "template") {
      return `No saved templates found in ${directory}. Create a reusable base diagram, then run excalidraw_save_template.`;
    }

    return `No saved diagrams found in ${directory}. Create or modify a diagram, then run excalidraw_save_diagram.`;
  }
  return [
    `Saved ${getBundlePlural(kind)} (${items.length}) in ${directory}:`,
    ...items.map(({ bundle, bundlePath }, index) => (
      `${index + 1}. ${bundle.name} — ${bundle.elementCount} element(s), ${bundle.fileCount} file asset(s), saved ${bundle.savedAt}, path ${toWorkspaceRelativePath(bundlePath)}`
    )),
  ].join("\n");
}

const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 120;
const DEFAULT_NODE_GAP = 180;
const DEFAULT_NODE_BACKGROUND = "#edf4ff";
const DEFAULT_NODE_STROKE = "#1f2937";
const DEFAULT_NODE_TEXT = "#0f172a";
const DEFAULT_CONNECTOR_COLOR = "#475569";
const DEFAULT_NODE_FONT_SIZE = 20;
const NODE_HORIZONTAL_PADDING = 24;
const NODE_VERTICAL_PADDING = 18;
const NODE_MIN_WIDTH = 120;
const NODE_MIN_HEIGHT = 72;
const NODE_AUTO_MIN_WIDTH = 160;
const NODE_AUTO_MIN_HEIGHT = 92;
const NODE_MAX_AUTO_WIDTH = 340;
const NODE_MAX_AUTO_HEIGHT = 260;
const NODE_RELATED_SIZE_BLEND = 0.45;
const NODE_RELATED_SIZE_MAX_DELTA = 72;
const NODE_RELATED_SIZE_OUTLIER_RATIO = 1.45;
const NODE_MIN_HARMONIZE_DELTA = 10;
const NODE_MIN_ADAPTIVE_GAP = 56;
const NODE_MAX_ADAPTIVE_GAP = 320;
const CONNECTOR_INSET = 10;
type NodeShape = "rectangle" | "rounded" | "ellipse" | "diamond";
type TextBoxMetrics = {
  width: number;
  height: number;
  lines: string[];
  longestLine: number;
  longestWord: number;
  compactLength: number;
  lineHeight: number;
  lineCount: number;
};
type BuiltNode = {
  nodeElement: any;
  labelElement: any;
  nodeId: string;
  labelId: string;
  groupId: string;
  meta: {
    shape: NodeShape;
    labelText: string;
    fontSize: number;
    textMetrics: TextBoxMetrics;
    minWidth: number;
    minHeight: number;
    widthLocked: boolean;
    heightLocked: boolean;
  };
};
function makeLocalId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function createElementsBatch(elements: any[]) {
  return callApi("POST", "/api/elements/batch", { elements });
}
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundDimension(value: number) {
  return Math.round(value / 2) * 2;
}
function normalizeLabelText(text: string): string {
  const normalized = String(text || "Node")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .join("\n")
    .trim();
  return normalized || "Node";
}

function getLabelTextStats(text: string) {
  const normalized = normalizeLabelText(text);
  const lines = normalized.split("\n");
  const compactLength = normalized.replace(/\s+/g, "").length;
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 1);
  const longestWord = normalized
    .split(/\s+/)
    .filter(Boolean)
    .reduce((max, word) => Math.max(max, word.length), 1);
  return {
    normalized,
    lines,
    compactLength,
    longestLine,
    longestWord,
    lineCount: lines.length,
  };
}
function splitWordIntoChunks(word: string, maxCharsPerLine: number) {
  if (word.length <= maxCharsPerLine) return [word];
  const chunks: string[] = [];
  for (let index = 0; index < word.length; index += maxCharsPerLine) {
    chunks.push(word.slice(index, index + maxCharsPerLine));
  }
  return chunks;
}

function estimateTextBox(text: string, maxWidth: number, fontSize: number): TextBoxMetrics {
  const stats = getLabelTextStats(text);
  const charWidth = Math.max(6, fontSize * 0.54);
  const lineHeight = Math.max(18, Math.round(fontSize * 1.35));
  const maxCharsPerLine = Math.max(8, Math.floor(maxWidth / charWidth));
  const lines: string[] = [];
  for (const rawLine of stats.lines) {
    const words = rawLine
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((word) => splitWordIntoChunks(word, maxCharsPerLine));
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (!current || candidate.length <= maxCharsPerLine) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 1);
  const textWidth = Math.min(maxWidth, Math.max(56, Math.round(longestLine * charWidth + Math.min(22, fontSize))));
  const textHeight = Math.max(lineHeight, lines.length * lineHeight);
  return {
    width: textWidth,
    height: textHeight,
    lines,
    longestLine,
    longestWord: stats.longestWord,
    compactLength: stats.compactLength,
    lineHeight,
    lineCount: lines.length,
  };
}
function chooseDefaultFontSize(labelText: string) {
  const stats = getLabelTextStats(labelText);
  if (stats.lineCount >= 3 || stats.compactLength > 72 || stats.longestWord > 18) return 15;
  if (stats.lineCount >= 2 || stats.compactLength > 44 || stats.longestLine > 20) return 16;
  if (stats.compactLength > 26 || stats.longestLine > 12) return 18;
  return DEFAULT_NODE_FONT_SIZE;
}
function normalizeNodeShape(shape: string | undefined): NodeShape {
  if (shape === "rounded" || shape === "ellipse" || shape === "diamond" || shape === "rectangle") return shape;
  return "rounded";
}

function getShapeContentPadding(shape: NodeShape) {
  if (shape === "ellipse") {
    return { horizontal: NODE_HORIZONTAL_PADDING + 10, vertical: NODE_VERTICAL_PADDING + 6 };
  }
  if (shape === "diamond") {
    return { horizontal: NODE_HORIZONTAL_PADDING + 14, vertical: NODE_VERTICAL_PADDING + 10 };
  }
  return { horizontal: NODE_HORIZONTAL_PADDING, vertical: NODE_VERTICAL_PADDING };
}

function chooseAutoTextWidth(labelText: string, fontSize: number, shape: NodeShape) {
  const stats = getLabelTextStats(labelText);
  const charWidth = Math.max(6, fontSize * 0.54);
  const { horizontal } = getShapeContentPadding(shape);
  const maxTextWidth = Math.max(96, NODE_MAX_AUTO_WIDTH - horizontal * 2);
  const preferredLines = stats.compactLength > 72 ? 4 : (stats.compactLength > 40 || stats.lineCount > 1 ? 3 : 2);
  const longestWordWidth = stats.longestWord * charWidth + 14;
  const longestLineWidth = stats.longestLine * charWidth * (stats.lineCount > 1 ? 0.96 : 0.88) + 18;
  const densityWidth = (stats.compactLength / preferredLines) * charWidth + 18;
  return clamp(
    Math.round(Math.max(120, longestWordWidth, longestLineWidth, densityWidth)),
    120,
    maxTextWidth,
  );
}

function measureNodeLabel(labelText: string, fontSize: number, shape: NodeShape, requestedTextWidth?: number) {
  const { horizontal } = getShapeContentPadding(shape);
  const maxTextWidth = Math.max(96, NODE_MAX_AUTO_WIDTH - horizontal * 2);
  let targetTextWidth = clamp(
    Math.round(requestedTextWidth ?? chooseAutoTextWidth(labelText, fontSize, shape)),
    96,
    maxTextWidth,
  );
  let textMetrics = estimateTextBox(labelText, targetTextWidth, fontSize);
  if (requestedTextWidth === undefined && textMetrics.lineCount >= 4 && targetTextWidth < maxTextWidth) {
    targetTextWidth = clamp(targetTextWidth + Math.min(72, (textMetrics.lineCount - 3) * 28), 96, maxTextWidth);
    textMetrics = estimateTextBox(labelText, targetTextWidth, fontSize);
  }
  return textMetrics;
}

function computeNodeMinimumSize(shape: NodeShape, textMetrics: TextBoxMetrics) {
  const padding = getShapeContentPadding(shape);
  return {
    minWidth: roundDimension(Math.max(NODE_MIN_WIDTH, textMetrics.width + padding.horizontal * 2)),
    minHeight: roundDimension(Math.max(NODE_MIN_HEIGHT, textMetrics.height + padding.vertical * 2)),
  };
}

function softlyHarmonizeDimension(current: number, target: number, min: number, locked: boolean) {
  if (locked || !Number.isFinite(current) || !Number.isFinite(target)) return Math.max(min, current);
  const safeCurrent = Math.max(min, current);
  const ratio = target > safeCurrent ? target / safeCurrent : safeCurrent / target;
  if (ratio > NODE_RELATED_SIZE_OUTLIER_RATIO) return safeCurrent;
  const delta = target - safeCurrent;
  if (Math.abs(delta) < NODE_MIN_HARMONIZE_DELTA) return safeCurrent;
  const boundedTarget = clamp(target, safeCurrent - NODE_RELATED_SIZE_MAX_DELTA, safeCurrent + NODE_RELATED_SIZE_MAX_DELTA);
  return roundDimension(Math.max(min, safeCurrent + (boundedTarget - safeCurrent) * NODE_RELATED_SIZE_BLEND));
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function chooseHarmonizedTarget(values: number[]) {
  if (values.length === 0) return 0;
  const baseline = median(values);
  const filtered = values.filter((value) => {
    const ratio = value > baseline ? value / baseline : baseline / value;
    return ratio <= NODE_RELATED_SIZE_OUTLIER_RATIO;
  });
  return median(filtered.length >= 2 ? filtered : values);
}

function harmonizeNodeDimensions(nodes: Array<{
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  widthLocked?: boolean;
  heightLocked?: boolean;
}>) {
  if (nodes.length < 2) return;
  const widthTarget = chooseHarmonizedTarget(nodes.map((node) => node.width));
  const heightTarget = chooseHarmonizedTarget(nodes.map((node) => node.height));
  for (const node of nodes) {
    node.width = softlyHarmonizeDimension(node.width, widthTarget, node.minWidth, Boolean(node.widthLocked));
    node.height = softlyHarmonizeDimension(node.height, heightTarget, node.minHeight, Boolean(node.heightLocked));
  }
}

function resolveAdaptiveGap(requestedGap: number, previousSpan: number, nextSpan: number, baselineSpan: number) {
  const averageSpan = (previousSpan + nextSpan) / 2;
  const scaledGap = requestedGap + (averageSpan - baselineSpan) * 0.35;
  const minGap = Math.max(40, Math.min(requestedGap, NODE_MIN_ADAPTIVE_GAP));
  const maxGap = Math.max(requestedGap + 96, NODE_MAX_ADAPTIVE_GAP);
  return clamp(Math.round(scaledGap), minGap, maxGap);
}
function buildNodeElements(input: {
  id?: string;
  label: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  shape?: string;
  strokeColor?: string;
  backgroundColor?: string;
  textColor?: string;
  fillStyle?: string;
  fontSize?: number;
}): BuiltNode {
  const nodeId = input.id || makeLocalId("node");
  const labelId = makeLocalId("label");
  const groupId = makeLocalId("group");
  const shape = normalizeNodeShape(input.shape);
  const labelText = normalizeLabelText(input.label);
  const requestedWidth = Number(input.width);
  const requestedHeight = Number(input.height);
  const requestedFontSize = Number(input.fontSize);
  const hasWidth = Number.isFinite(requestedWidth);
  const hasHeight = Number.isFinite(requestedHeight);
  const hasFontSize = Number.isFinite(requestedFontSize);
  const fontSize = Math.round(Math.max(14, hasFontSize ? requestedFontSize : chooseDefaultFontSize(labelText)));
  const requestedTextWidth = hasWidth
    ? Math.max(96, requestedWidth - getShapeContentPadding(shape).horizontal * 2)
    : undefined;
  const textMetrics = measureNodeLabel(labelText, fontSize, shape, requestedTextWidth);
  const { minWidth, minHeight } = computeNodeMinimumSize(shape, textMetrics);

  const width = roundDimension(hasWidth
    ? Math.max(minWidth, requestedWidth)
    : clamp(minWidth, NODE_AUTO_MIN_WIDTH, NODE_MAX_AUTO_WIDTH));
  const height = roundDimension(hasHeight
    ? Math.max(minHeight, requestedHeight)
    : clamp(minHeight, NODE_AUTO_MIN_HEIGHT, NODE_MAX_AUTO_HEIGHT));
  const nodeType = shape === "rounded" ? "rectangle" : shape;
  const nodeElement: any = {
    id: nodeId,
    type: nodeType,
    x: Number(input.x),
    y: Number(input.y),
    width,
    height,
    strokeColor: input.strokeColor ?? DEFAULT_NODE_STROKE,
    backgroundColor: input.backgroundColor ?? DEFAULT_NODE_BACKGROUND,
    strokeWidth: 2,
    fillStyle: input.fillStyle ?? "solid",
    roughness: 0,
    groupIds: [groupId],
  };
  if (shape === "rounded") {
    nodeElement.roundness = { type: 3 };
  }
  const labelElement = {
    id: labelId,
    type: "text",
    x: Number(input.x) + (width - textMetrics.width) / 2,
    y: Number(input.y) + (height - textMetrics.height) / 2,
    width: textMetrics.width,
    height: textMetrics.height,
    text: labelText,
    fontSize,
    strokeColor: input.textColor ?? DEFAULT_NODE_TEXT,
    groupIds: [groupId],
  };

  return {
    nodeElement,
    labelElement,
    nodeId,
    labelId,
    groupId,
    meta: {
      shape,
      labelText,
      fontSize,
      textMetrics,
      minWidth,
      minHeight,
      widthLocked: hasWidth,
      heightLocked: hasHeight,
    },
  };
}

function harmonizeBuiltNodes(nodes: BuiltNode[]) {
  const dimensions = nodes.map((node) => ({
    width: Number(node.nodeElement.width ?? DEFAULT_NODE_WIDTH),
    height: Number(node.nodeElement.height ?? DEFAULT_NODE_HEIGHT),
    minWidth: node.meta.minWidth,
    minHeight: node.meta.minHeight,
    widthLocked: node.meta.widthLocked,
    heightLocked: node.meta.heightLocked,
  }));
  harmonizeNodeDimensions(dimensions);

  nodes.forEach((node, index) => {
    const next = dimensions[index];
    node.nodeElement.width = next.width;
    node.nodeElement.height = next.height;
    node.labelElement.x = Number(node.nodeElement.x ?? 0) + (next.width - Number(node.labelElement.width ?? 0)) / 2;
    node.labelElement.y = Number(node.nodeElement.y ?? 0) + (next.height - Number(node.labelElement.height ?? 0)) / 2;
  });
}

function translateBuiltNode(node: BuiltNode, x: number, y: number) {
  node.nodeElement.x = x;
  node.nodeElement.y = y;
  node.labelElement.x = x + (Number(node.nodeElement.width ?? 0) - Number(node.labelElement.width ?? 0)) / 2;
  node.labelElement.y = y + (Number(node.nodeElement.height ?? 0) - Number(node.labelElement.height ?? 0)) / 2;
  return node;
}
function computeSequentialNodeTargets(
  nodes: Array<{ id: string; width?: number; height?: number }>,
  mode: "horizontal" | "vertical" | "centered-flow",
  startX: number,
  startY: number,
  gap: number,
  laneOffset: number,
) {
  const targetPositions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return targetPositions;
  const maxWidth = Math.max(...nodes.map((node) => Number(node.width ?? DEFAULT_NODE_WIDTH)));
  const maxHeight = Math.max(...nodes.map((node) => Number(node.height ?? DEFAULT_NODE_HEIGHT)));
  let cursorX = startX;
  let cursorY = startY;

  nodes.forEach((node, index) => {
    const width = Number(node.width ?? DEFAULT_NODE_WIDTH);
    const height = Number(node.height ?? DEFAULT_NODE_HEIGHT);
    let x = startX;
    let y = startY;
    if (index > 0) {
      const previous = nodes[index - 1];
      const previousWidth = Number(previous?.width ?? DEFAULT_NODE_WIDTH);
      const previousHeight = Number(previous?.height ?? DEFAULT_NODE_HEIGHT);
      if (mode === "vertical") {
        cursorY += previousHeight + resolveAdaptiveGap(gap, previousHeight, height, DEFAULT_NODE_HEIGHT);
      } else {
        cursorX += previousWidth + resolveAdaptiveGap(gap, previousWidth, width, DEFAULT_NODE_WIDTH);
      }
    }
    if (mode === "vertical") {
      x = startX + (maxWidth - width) / 2;
      y = cursorY;
    } else if (mode === "centered-flow") {
      const laneDirection = index === 0 ? 0 : (index % 2 === 0 ? 1 : -1);
      x = cursorX;
      y = startY + (maxHeight - height) / 2 + laneDirection * laneOffset;
    } else {
      x = cursorX;
      y = startY + (maxHeight - height) / 2;
    }
    targetPositions.set(node.id, { x, y });
  });
  return targetPositions;
}

function buildConnectorPoints(start: { x: number; y: number }, end: { x: number; y: number }, preferElbowed: boolean) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (!preferElbowed || Math.abs(dx) < 36 || Math.abs(dy) < 36) {
    return {
      points: [[0, 0], [dx, dy]],
      elbowed: false,
    };
  }

  if (Math.abs(dx) >= Math.abs(dy)) {
    const midX = dx / 2;
    return {
      points: [[0, 0], [midX, 0], [midX, dy], [dx, dy]],
      elbowed: true,
    };
  }

  const midY = dy / 2;
  return {
    points: [[0, 0], [0, midY], [dx, midY], [dx, dy]],
    elbowed: true,
  };
}
function computeCenter(element: any, target?: { x: number; y: number; width?: number; height?: number }) {
  const x = target?.x ?? Number(element?.x ?? 0);
  const y = target?.y ?? Number(element?.y ?? 0);
  const width = target?.width ?? Number(element?.width ?? 0);
  const height = target?.height ?? Number(element?.height ?? 0);
  return { x: x + width / 2, y: y + height / 2 };
}
function computeEdgePoint(
  element: any,
  targetCenterX: number,
  targetCenterY: number,
  target?: { x: number; y: number; width?: number; height?: number },
) {
  const { x: cx, y: cy } = computeCenter(element, target);
  const width = target?.width ?? Number(element?.width ?? 0);
  const height = target?.height ?? Number(element?.height ?? 0);
  const dx = targetCenterX - cx;
  const dy = targetCenterY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  if (element?.type === "diamond") {
    const hw = Math.max(1, width / 2);
    const hh = Math.max(1, height / 2);
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const scale = (absDx / hw + absDy / hh) > 0 ? 1 / (absDx / hw + absDy / hh) : 1;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }
  if (element?.type === "ellipse") {
    const a = Math.max(1, width / 2);
    const b = Math.max(1, height / 2);
    const angle = Math.atan2(dy, dx);
    return { x: cx + a * Math.cos(angle), y: cy + b * Math.sin(angle) };
  }

  const hw = Math.max(1, width / 2);
  const hh = Math.max(1, height / 2);
  const angle = Math.atan2(dy, dx);
  const tanA = Math.tan(angle);
  if (Math.abs(tanA * hw) <= hh) {
    const signX = dx >= 0 ? 1 : -1;
    return { x: cx + signX * hw, y: cy + signX * hw * tanA };
  }
  const signY = dy >= 0 ? 1 : -1;
  return { x: cx + signY * hh / tanA, y: cy + signY * hh };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("excalidraw", {
    description: "Start local Excalidraw canvas and show URL",
    handler: async (_args, ctx) => {
      const url = await ensureCanvasRunning(ctx as any);
      ctx.ui.notify(`Excalidraw ready: ${url}`, "info");
      ctx.ui.notify(`Open in browser pane: ${url}`, "info");
      ctx.ui.notify(`For screenshots and viewport tools, keep the canvas page open.`, "info");
    },
  });

  pi.registerTool({
    name: "excalidraw_open",
    label: "Open Excalidraw",
    description: "Ensure the Excalidraw canvas server is running and return its URL",
    parameters: Type.Object({}),
    async execute() {
      const url = await ensureCanvasRunning();
      return {
        content: [{ type: "text", text: `Excalidraw is running at ${url}. ${BROWSER_CLIENT_HINT}` }],
        details: { url, hint: BROWSER_CLIENT_HINT },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_create_elements",
    label: "Create Excalidraw Elements",
    description: "Low-level primitive: create raw Excalidraw elements. Prefer high-level generation tools for structured diagrams.",
    parameters: Type.Object({
      elements: Type.Array(Type.Any({ description: "Excalidraw element payload" })),
    }),
    async execute(_id, params: any) {
      const result = await createElementsBatch(params.elements);
      return {
        content: [{ type: "text", text: `Created ${result?.count ?? 0} element(s).` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_create_labeled_box",
    label: "Create Labeled Box",
    description: "High-level generation helper: create a polished box plus centered label in one call. Omit width/height/fontSize to use the cleaner auto-sizing defaults.",
    parameters: Type.Object({
      label: Type.String({ description: "Text displayed inside the box" }),
      x: Type.Number(),
      y: Type.Number(),
      width: Type.Optional(Type.Number({ description: "Optional fixed width. Omit for auto sizing." })),
      height: Type.Optional(Type.Number({ description: "Optional fixed height. Omit for auto sizing." })),
      shape: Type.Optional(Type.Union([Type.Literal("rectangle"), Type.Literal("rounded")], { default: "rounded" })),
      backgroundColor: Type.Optional(Type.String({ default: DEFAULT_NODE_BACKGROUND })),
      strokeColor: Type.Optional(Type.String({ default: DEFAULT_NODE_STROKE })),
      textColor: Type.Optional(Type.String({ default: DEFAULT_NODE_TEXT })),
      fontSize: Type.Optional(Type.Number({ description: "Optional fixed font size. Omit for auto sizing." })),
    }),
    async execute(_id, params: any) {
      const node = buildNodeElements({
        label: params.label,
        x: params.x,
        y: params.y,
        width: params.width,
        height: params.height,
        shape: params.shape,
        backgroundColor: params.backgroundColor,
        strokeColor: params.strokeColor,
        textColor: params.textColor,
        fontSize: params.fontSize,
      });

      const result = await createElementsBatch([node.nodeElement, node.labelElement]);
      return {
        content: [{
          type: "text",
          text: `Created polished labeled box "${params.label}" as 2 coordinated elements. For cleaner multi-node results, use excalidraw_layout_diagram next, then excalidraw_focus_canvas and excalidraw_capture_screenshot.`,
        }],
        details: {
          ...result,
          nodeId: node.nodeId,
          labelId: node.labelId,
        },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_create_node",
    label: "Create Diagram Node",
    description: "High-level generation helper: create a polished node shape (rectangle/rounded/ellipse/diamond) with a centered label. Omit width/height/fontSize to use the cleaner auto-sizing defaults.",
    parameters: Type.Object({
      label: Type.String(),
      x: Type.Number(),
      y: Type.Number(),
      width: Type.Optional(Type.Number({ description: "Optional fixed width. Omit for auto sizing." })),
      height: Type.Optional(Type.Number({ description: "Optional fixed height. Omit for auto sizing." })),
      shape: Type.Optional(Type.Union([
        Type.Literal("rectangle"),
        Type.Literal("rounded"),
        Type.Literal("ellipse"),
        Type.Literal("diamond"),
      ], { default: "rounded" })),
      backgroundColor: Type.Optional(Type.String({ default: DEFAULT_NODE_BACKGROUND })),
      strokeColor: Type.Optional(Type.String({ default: DEFAULT_NODE_STROKE })),
      textColor: Type.Optional(Type.String({ default: DEFAULT_NODE_TEXT })),
      fontSize: Type.Optional(Type.Number({ description: "Optional fixed font size. Omit for auto sizing." })),
    }),
    async execute(_id, params: any) {
      const node = buildNodeElements({
        label: params.label,
        x: params.x,
        y: params.y,
        width: params.width,
        height: params.height,
        shape: params.shape,
        backgroundColor: params.backgroundColor,
        strokeColor: params.strokeColor,
        textColor: params.textColor,
        fontSize: params.fontSize,
      });

      const result = await createElementsBatch([node.nodeElement, node.labelElement]);
      return {
        content: [{
          type: "text",
          text: `Created polished node "${params.label}" (${normalizeNodeShape(params.shape)}). Use excalidraw_create_connected_nodes for multi-step flows, or excalidraw_layout_diagram to polish spacing before the final screenshot check.`,
        }],
        details: {
          ...result,
          nodeId: node.nodeId,
          labelId: node.labelId,
          groupId: node.groupId,
        },
      };
    },
  });
  pi.registerTool({
    name: "excalidraw_create_connected_nodes",
    label: "Create Connected Nodes",
    description: "High-level diagram generator: create multiple labeled nodes plus connector arrows with cleaner default sizing, spacing, and routing in one operation.",
    parameters: Type.Object({
      nodes: Type.Array(Type.Object({
        label: Type.String(),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        width: Type.Optional(Type.Number()),
        height: Type.Optional(Type.Number()),
        shape: Type.Optional(Type.Union([
          Type.Literal("rectangle"),
          Type.Literal("rounded"),
          Type.Literal("ellipse"),
          Type.Literal("diamond"),
        ])),
      }), { minItems: 2 }),
      direction: Type.Optional(Type.Union([Type.Literal("horizontal"), Type.Literal("vertical")], { default: "horizontal" })),
      startX: Type.Optional(Type.Number({ default: 140 })),
      startY: Type.Optional(Type.Number({ default: 140 })),
      gap: Type.Optional(Type.Number({ default: DEFAULT_NODE_GAP })),
      nodeBackgroundColor: Type.Optional(Type.String({ default: DEFAULT_NODE_BACKGROUND })),
      nodeStrokeColor: Type.Optional(Type.String({ default: DEFAULT_NODE_STROKE })),
      textColor: Type.Optional(Type.String({ default: DEFAULT_NODE_TEXT })),
      connectorColor: Type.Optional(Type.String({ default: DEFAULT_CONNECTOR_COLOR })),
      arrowHead: Type.Optional(Type.Union([Type.Literal("arrow"), Type.Literal("triangle"), Type.Literal("none")], { default: "arrow" })),
      elbowed: Type.Optional(Type.Boolean({ default: false })),
      fontSize: Type.Optional(Type.Number({ description: "Optional fixed font size for all generated labels. Omit for auto sizing." })),
    }),
    async execute(_id, params: any) {
      const nodes = Array.isArray(params.nodes) ? params.nodes : [];
      if (nodes.length < 2) {
        throw new Error("excalidraw_create_connected_nodes requires at least 2 nodes.");
      }
      const direction = params.direction ?? "horizontal";
      const gap = Math.max(40, Number(params.gap ?? DEFAULT_NODE_GAP));
      const startX = Number(params.startX ?? 140);
      const startY = Number(params.startY ?? 140);
      const elementBatch: any[] = [];
      const nodeIds: string[] = [];
      const connectorIds: string[] = [];
      const builtNodes: BuiltNode[] = nodes.map((nodeInput: any) => buildNodeElements({
        label: nodeInput.label,
        x: 0,
        y: 0,
        width: nodeInput.width,
        height: nodeInput.height,
        shape: nodeInput.shape,
        backgroundColor: params.nodeBackgroundColor,
        strokeColor: params.nodeStrokeColor,
        textColor: params.textColor,
        fontSize: params.fontSize,
      }));
      harmonizeBuiltNodes(builtNodes);
      const autoTargets = computeSequentialNodeTargets(
        builtNodes.map((node: BuiltNode) => ({
          id: node.nodeId,
          width: Number(node.nodeElement.width ?? DEFAULT_NODE_WIDTH),
          height: Number(node.nodeElement.height ?? DEFAULT_NODE_HEIGHT),
        })),
        direction === "vertical" ? "vertical" : "horizontal",
        startX,
        startY,
        gap,
        0,
      );

      builtNodes.forEach((node: BuiltNode, index: number) => {
        const nodeInput = nodes[index] ?? {};
        const autoTarget = autoTargets.get(node.nodeId) ?? { x: startX, y: startY };
        const targetX = Number.isFinite(Number(nodeInput.x)) ? Number(nodeInput.x) : autoTarget.x;
        const targetY = Number.isFinite(Number(nodeInput.y)) ? Number(nodeInput.y) : autoTarget.y;
        translateBuiltNode(node, targetX, targetY);
        nodeIds.push(node.nodeId);
        elementBatch.push(node.nodeElement, node.labelElement);
      });
      for (let i = 0; i < builtNodes.length - 1; i++) {
        const startNode = builtNodes[i].nodeElement;
        const endNode = builtNodes[i + 1].nodeElement;
        const startCenter = computeCenter(startNode);
        const endCenter = computeCenter(endNode);
        const rawStart = computeEdgePoint(startNode, endCenter.x, endCenter.y);
        const rawEnd = computeEdgePoint(endNode, startCenter.x, startCenter.y);
        const vx = rawEnd.x - rawStart.x;
        const vy = rawEnd.y - rawStart.y;
        const dist = Math.hypot(vx, vy) || 1;
        const finalStart = {
          x: rawStart.x + (vx / dist) * CONNECTOR_INSET,
          y: rawStart.y + (vy / dist) * CONNECTOR_INSET,
        };
        const finalEnd = {
          x: rawEnd.x - (vx / dist) * CONNECTOR_INSET,
          y: rawEnd.y - (vy / dist) * CONNECTOR_INSET,
        };
        const connectorPath = buildConnectorPoints(finalStart, finalEnd, Boolean(params.elbowed));
        const connectorId = makeLocalId("arrow");
        connectorIds.push(connectorId);
        elementBatch.push({
          id: connectorId,
          type: "arrow",
          x: finalStart.x,
          y: finalStart.y,
          points: connectorPath.points,
          start: { id: builtNodes[i].nodeId },
          end: { id: builtNodes[i + 1].nodeId },
          strokeColor: params.connectorColor ?? DEFAULT_CONNECTOR_COLOR,
          strokeWidth: 2,
          roughness: 0,
          endArrowhead: params.arrowHead === "none" ? null : (params.arrowHead ?? "arrow"),
          elbowed: connectorPath.elbowed,
        });
      }
      const result = await createElementsBatch(elementBatch);
      return {
        content: [{
          type: "text",
          text: `Created ${nodeIds.length} connected node(s) and ${connectorIds.length} connector arrow(s) with softer related-node sizing and more adaptive spacing. Next: run excalidraw_layout_diagram to polish the composition further, then excalidraw_focus_canvas and excalidraw_capture_screenshot.`,
        }],
        details: {
          ...result,
          nodeIds,
          connectorIds,
        },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_layout_diagram",
    label: "Layout Diagram",
    description: "Layout + polish helper: rearrange node-like elements into deterministic horizontal, vertical, or centered-flow layouts with cleaner spacing and connector refresh behavior.",
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([
        Type.Literal("horizontal"),
        Type.Literal("vertical"),
        Type.Literal("centered-flow"),
      ], { default: "horizontal" })),
      elementIds: Type.Optional(Type.Array(Type.String())),
      gap: Type.Optional(Type.Number({ default: DEFAULT_NODE_GAP })),
      startX: Type.Optional(Type.Number()),
      startY: Type.Optional(Type.Number()),
      laneOffset: Type.Optional(Type.Number({ default: 72 })),
    }),
    async execute(_id, params: any) {
      const mode = params.mode ?? "horizontal";
      const gap = Math.max(40, Number(params.gap ?? DEFAULT_NODE_GAP));
      const laneOffset = Math.max(20, Number(params.laneOffset ?? 72));
      const current = await callApi("GET", "/api/elements");
      const allElements = Array.isArray(current?.elements) ? current.elements : [];
      const nodeTypes = new Set(["rectangle", "ellipse", "diamond"]);
      const selectedIds = Array.isArray(params.elementIds) && params.elementIds.length > 0
        ? new Set(params.elementIds.map((id: any) => String(id)))
        : null;
      let nodes = allElements.filter((element: any) => {
        if (!nodeTypes.has(String(element?.type ?? ""))) return false;
        if (!selectedIds) return true;
        return selectedIds.has(String(element?.id ?? ""));
      });
      if (nodes.length < 2) {
        throw new Error("Layout requires at least 2 node-like elements (rectangle/ellipse/diamond). Provide elementIds if needed.");
      }
      nodes = [...nodes].sort((a: any, b: any) => {
        if (mode === "vertical") {
          return Number(a?.y ?? 0) - Number(b?.y ?? 0) || Number(a?.x ?? 0) - Number(b?.x ?? 0);
        }
        return Number(a?.x ?? 0) - Number(b?.x ?? 0) || Number(a?.y ?? 0) - Number(b?.y ?? 0);
      });
      const elementById = new Map<string, any>();
      const textByGroupId = new Map<string, any>();
      for (const element of allElements) {
        if (typeof element?.id === "string") {
          elementById.set(element.id, element);
        }
        if (element?.type === "text") {
          const groupIds = Array.isArray(element.groupIds) ? element.groupIds : [];
          for (const groupId of groupIds) {
            if (!textByGroupId.has(groupId)) {
              textByGroupId.set(groupId, element);
            }
          }
        }
      }

      const layoutNodes: Array<{ id: string; element: any; labelElement: any; width: number; height: number; minWidth: number; minHeight: number; }> = nodes.map((node: any) => {
        const groupIds = Array.isArray(node.groupIds) ? node.groupIds : [];
        const labelElement = groupIds.map((groupId: string) => textByGroupId.get(groupId)).find(Boolean);
        const shape = normalizeNodeShape(
          node?.type === "rectangle" && node?.roundness ? "rounded" : String(node?.type ?? "rectangle"),
        );
        const padding = getShapeContentPadding(shape);
        const currentWidth = Number(node?.width ?? DEFAULT_NODE_WIDTH);
        const currentHeight = Number(node?.height ?? DEFAULT_NODE_HEIGHT);
        const labelWidth = Number(labelElement?.width ?? 0);
        const labelHeight = Number(labelElement?.height ?? 0);
        return {
          id: String(node.id),
          element: node,
          labelElement,
          width: currentWidth,
          height: currentHeight,
          minWidth: labelElement
            ? roundDimension(Math.max(NODE_MIN_WIDTH, labelWidth + padding.horizontal * 2))
            : currentWidth,
          minHeight: labelElement
            ? roundDimension(Math.max(NODE_MIN_HEIGHT, labelHeight + padding.vertical * 2))
            : currentHeight,
        };
      });
      harmonizeNodeDimensions(layoutNodes);

      const minX = Math.min(...layoutNodes.map((node: { element: any }) => Number(node.element?.x ?? 0)));
      const minY = Math.min(...layoutNodes.map((node: { element: any }) => Number(node.element?.y ?? 0)));
      const parsedStartX = Number(params.startX);
      const parsedStartY = Number(params.startY);
      const startX = Number.isFinite(parsedStartX) ? parsedStartX : minX;
      const startY = Number.isFinite(parsedStartY) ? parsedStartY : minY;
      const targetPositions = computeSequentialNodeTargets(
        layoutNodes.map((node: { id: string; width: number; height: number }) => ({ id: node.id, width: node.width, height: node.height })),
        mode,
        startX,
        startY,
        gap,
        laneOffset,
      );
      const targetFrames = new Map<string, { x: number; y: number; width: number; height: number }>();
      for (const node of layoutNodes) {
        const target = targetPositions.get(node.id);
        if (!target) continue;
        targetFrames.set(node.id, {
          x: target.x,
          y: target.y,
          width: node.width,
          height: node.height,
        });
      }
      const updates: Array<{ id: string; updates: any }> = [];
      let resizedNodes = 0;
      for (const node of layoutNodes) {
        const frame = targetFrames.get(node.id);
        if (!frame) continue;
        if (
          frame.width !== Number(node.element?.width ?? 0)
          || frame.height !== Number(node.element?.height ?? 0)
        ) {
          resizedNodes++;
        }
        updates.push({
          id: node.id,
          updates: {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
          },
        });
      }
      let movedLabels = 0;
      for (const node of layoutNodes) {
        const frame = targetFrames.get(node.id);
        const labelElement = node.labelElement;
        if (!frame || !labelElement || typeof labelElement?.id !== "string") continue;
        updates.push({
          id: labelElement.id,
          updates: {
            x: frame.x + (frame.width - Number(labelElement?.width ?? 0)) / 2,
            y: frame.y + (frame.height - Number(labelElement?.height ?? 0)) / 2,
          },
        });
        movedLabels++;
      }
      let movedConnectors = 0;
      for (const connector of allElements) {
        if (connector?.type !== "arrow" || typeof connector?.id !== "string") continue;
        const startId = typeof connector?.start?.id === "string" ? connector.start.id : null;
        const endId = typeof connector?.end?.id === "string" ? connector.end.id : null;
        if (!startId || !endId) continue;
        const startElement = elementById.get(startId);
        const endElement = elementById.get(endId);
        if (!startElement || !endElement) continue;
        const startTarget = targetFrames.get(startId);
        const endTarget = targetFrames.get(endId);
        if (!startTarget && !endTarget) continue;
        const startCenter = computeCenter(startElement, startTarget);
        const endCenter = computeCenter(endElement, endTarget);
        const rawStart = computeEdgePoint(startElement, endCenter.x, endCenter.y, startTarget);
        const rawEnd = computeEdgePoint(endElement, startCenter.x, startCenter.y, endTarget);
        const vx = rawEnd.x - rawStart.x;
        const vy = rawEnd.y - rawStart.y;
        const dist = Math.hypot(vx, vy) || 1;
        const finalStart = {
          x: rawStart.x + (vx / dist) * CONNECTOR_INSET,
          y: rawStart.y + (vy / dist) * CONNECTOR_INSET,
        };
        const finalEnd = {
          x: rawEnd.x - (vx / dist) * CONNECTOR_INSET,
          y: rawEnd.y - (vy / dist) * CONNECTOR_INSET,
        };
        const preferElbowed = Boolean(connector?.elbowed)
          || (mode === "centered-flow" && Math.abs(finalEnd.y - finalStart.y) >= 24);
        const connectorPath = buildConnectorPoints(finalStart, finalEnd, preferElbowed);
        updates.push({
          id: connector.id,
          updates: {
            x: finalStart.x,
            y: finalStart.y,
            points: connectorPath.points,
            elbowed: connectorPath.elbowed,
          },
        });
        movedConnectors++;
      }
      const latestById = new Map<string, any>();
      for (const update of updates) {
        latestById.set(update.id, update.updates);
      }
      for (const [id, payload] of latestById.entries()) {
        await callApi("PUT", `/api/elements/${encodeURIComponent(id)}`, payload);
      }
      return {
        content: [{
          type: "text",
          text: `Applied ${mode} layout/polish to ${layoutNodes.length} node(s), softly resized ${resizedNodes}, re-centered ${movedLabels} grouped label(s), and refreshed ${movedConnectors} connector(s). Next: run excalidraw_focus_canvas, then excalidraw_capture_screenshot as the final visual quality check.`,
        }],
        details: {
          mode,
          gap,
          laneOffset,
          movedNodes: layoutNodes.length,
          resizedNodes,
          movedLabels,
          movedConnectors,
          updatedIds: Array.from(latestById.keys()),
        },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_save_diagram",
    label: "Save Excalidraw Diagram",
    description: "Persistence helper for concrete working diagrams: save the current canvas scene into .pi/excalidraw-diagrams so it can be resumed later with list/load, focus, and screenshot validation. For reusable starters, use excalidraw_save_template.",
    parameters: Type.Object({
      name: Type.String({ description: "Human-readable diagram name used for the saved bundle filename" }),
    }),
    async execute(_id, params: any) {
      const plannedPath = getBundlePath("diagram", params.name);
      const { bundle, bundlePath } = await writeSceneBundle("diagram", params.name);
      return {
        content: [{
          type: "text",
          text: `Saved concrete diagram "${bundle.name}" to ${toWorkspaceRelativePath(bundlePath)} with ${bundle.elementCount} element(s) and ${bundle.fileCount} file asset(s). Next: use excalidraw_list_saved_diagrams or excalidraw_load_diagram to resume this exact state, then excalidraw_focus_canvas and excalidraw_capture_screenshot for visual validation.`,
        }],
        details: {
          ...bundle,
          bundlePath,
          sourcePath: toWorkspaceRelativePath(bundlePath),
          plannedPath: toWorkspaceRelativePath(plannedPath),
        },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_list_saved_diagrams",
    label: "List Saved Excalidraw Diagrams",
    description: "Persistence helper for concrete diagrams: discover previously saved bundles in the project before resuming edits with load, focus, and screenshot validation.",
    parameters: Type.Object({}),
    async execute() {
      const bundles = await listSceneBundles("diagram");
      return {
        content: [{ type: "text", text: summarizeBundles("diagram", bundles) }],
        details: {
          diagrams: bundles.map(({ bundle, bundlePath }) => ({
            ...bundle,
            bundlePath,
            sourcePath: toWorkspaceRelativePath(bundlePath),
          })),
          directory: toWorkspaceRelativePath(getBundlesDirectory("diagram")),
          count: bundles.length,
        },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_load_diagram",
    label: "Load Saved Excalidraw Diagram",
    description: "Persistence helper for concrete diagrams: restore a previously saved bundle into the live canvas, then optionally re-layout/polish it before focus + screenshot validation.",
    parameters: Type.Object({
      name: Type.String({ description: "Saved diagram name, slug, filename, or workspace-relative path" }),
    }),
    async execute(_id, params: any) {
      const { bundle, bundlePath } = await resolveSceneBundle("diagram", params.name);
      await replaceCanvasScene(bundle);
      return {
        content: [{
          type: "text",
          text: `Loaded diagram "${bundle.name}" from ${toWorkspaceRelativePath(bundlePath)} into the live canvas with ${bundle.elementCount} element(s) and ${bundle.fileCount} file asset(s). Next: if you want a cleaner presentation, run excalidraw_layout_diagram, then excalidraw_focus_canvas and excalidraw_capture_screenshot to validate the restored result.`,
        }],
        details: {
          ...bundle,
          bundlePath,
          sourcePath: toWorkspaceRelativePath(bundlePath),
          restored: true,
        },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_save_template",
    label: "Save Excalidraw Template",
    description: "Template helper for recurring diagram patterns: save the current canvas as a reusable starter structure in .pi/excalidraw-templates.",
    parameters: Type.Object({
      name: Type.String({ description: "Template name used to save a reusable starter bundle" }),
    }),
    async execute(_id, params: any) {
      const plannedPath = getBundlePath("template", params.name);
      const { bundle, bundlePath } = await writeSceneBundle("template", params.name);
      return {
        content: [{
          type: "text",
          text: `Saved reusable template "${bundle.name}" to ${toWorkspaceRelativePath(bundlePath)} with ${bundle.elementCount} element(s) and ${bundle.fileCount} file asset(s). Workflow: create a strong base once → save template → later list/apply template → customize or layout/polish → save as diagram → focus + screenshot validate.`,
        }],
        details: {
          ...bundle,
          bundlePath,
          sourcePath: toWorkspaceRelativePath(bundlePath),
          plannedPath: toWorkspaceRelativePath(plannedPath),
        },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_list_templates",
    label: "List Excalidraw Templates",
    description: "Template discovery helper: list reusable starter bundles saved in .pi/excalidraw-templates so the LLM can choose one to apply.",
    parameters: Type.Object({}),
    async execute() {
      const bundles = await listSceneBundles("template");
      return {
        content: [{ type: "text", text: summarizeBundles("template", bundles) }],
        details: {
          templates: bundles.map(({ bundle, bundlePath }) => ({
            ...bundle,
            bundlePath,
            sourcePath: toWorkspaceRelativePath(bundlePath),
          })),
          directory: toWorkspaceRelativePath(getBundlesDirectory("template")),
          count: bundles.length,
        },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_apply_template",
    label: "Apply Excalidraw Template",
    description: "Template helper: restore a saved template bundle into the live canvas as a starting point for new work, then route naturally into layout/polish plus screenshot validation.",
    parameters: Type.Object({
      name: Type.String({ description: "Saved template name, slug, filename, or workspace-relative path" }),
    }),
    async execute(_id, params: any) {
      const { bundle, bundlePath } = await resolveSceneBundle("template", params.name);
      await replaceCanvasScene(bundle);
      return {
        content: [{
          type: "text",
          text: `Applied template "${bundle.name}" from ${toWorkspaceRelativePath(bundlePath)} as a starter canvas with ${bundle.elementCount} element(s) and ${bundle.fileCount} file asset(s). Next: customize this scene or run excalidraw_layout_diagram for a quick polish, save the result with excalidraw_save_diagram, then excalidraw_focus_canvas and excalidraw_capture_screenshot to validate the outcome.`,
        }],
        details: {
          ...bundle,
          bundlePath,
          sourcePath: toWorkspaceRelativePath(bundlePath),
          applied: true,
        },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_get_elements",
    label: "Get Excalidraw Elements",
    description: "Inspect current canvas elements before layout, viewport focusing, or screenshot validation.",
    parameters: Type.Object({}),
    async execute() {
      const result = await callApi("GET", "/api/elements");
      return {
        content: [{ type: "text", text: summarizeElements(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_update_element",
    label: "Update Excalidraw Element",
    description: "Low-level primitive: patch a specific element by id when high-level tools are not enough.",
    parameters: Type.Object({
      id: Type.String(),
      updates: Type.Any({ description: "Partial element fields to update" }),
    }),
    async execute(_id, params: any) {
      const result = await callApi("PUT", `/api/elements/${encodeURIComponent(params.id)}`, params.updates ?? {});
      return {
        content: [{ type: "text", text: `Updated element ${params.id}.` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_delete_element",
    label: "Delete Excalidraw Element",
    description: "Delete an element from the Excalidraw canvas",
    parameters: Type.Object({
      id: Type.String(),
    }),
    async execute(_id, params: any) {
      const result = await callApi("DELETE", `/api/elements/${encodeURIComponent(params.id)}`);
      return {
        content: [{ type: "text", text: `Deleted element ${params.id}.` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_clear_canvas",
    label: "Clear Excalidraw Canvas",
    description: "Remove all elements from the Excalidraw canvas",
    parameters: Type.Object({}),
    async execute() {
      const result = await callApi("DELETE", "/api/elements/clear");
      return {
        content: [{ type: "text", text: `Cleared canvas.` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_export_scene",
    label: "Export Excalidraw Scene",
    description: "Return all current elements as scene JSON",
    parameters: Type.Object({}),
    async execute() {
      const result = await callApi("GET", "/api/elements");
      return {
        content: [{ type: "text", text: `${summarizeElements(result)}\n\nRaw scene JSON is available in tool details.` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_export_image",
    label: "Export Excalidraw Image",
    description: "Export the current Excalidraw canvas as PNG or SVG. Requires a connected browser canvas.",
    parameters: Type.Object({
      format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("svg")], { default: "png" })),
      background: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_id, params: any) {
      const format = params.format ?? "png";
      const background = params.background ?? true;
      const result = await callApi("POST", "/api/export/image", { format, background });
      const content: any[] = [
        { type: "text", text: `${summarizeExport(result, format)} ${BROWSER_CLIENT_HINT}` },
      ];
      if (format === "png" && typeof result?.data === "string") {
        content.push({ type: "image", data: result.data, mimeType: "image/png" });
      }
      return {
        content,
        details: { ...result, format, background },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_capture_screenshot",
    label: "Capture Excalidraw Screenshot",
    description: "Capture a PNG screenshot of the current canvas as the final visual quality check after generation, layout, or template application.",
    parameters: Type.Object({
      background: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_id, params: any) {
      const background = params.background ?? true;
      const result = await callApi("POST", "/api/export/image", { format: "png", background });
      return {
        content: [
          { type: "text", text: `${summarizeExport(result, "png")} Screenshot attached below for inspection.` },
          { type: "image", data: result.data, mimeType: "image/png" },
        ],
        details: { ...result, format: "png", background },
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_set_viewport",
    label: "Set Excalidraw Viewport",
    description: "Adjust the Excalidraw viewport to fit content, center an element, or set zoom/offset explicitly.",
    parameters: Type.Object({
      scrollToContent: Type.Optional(Type.Boolean()),
      scrollToElementId: Type.Optional(Type.String()),
      zoom: Type.Optional(Type.Number()),
      offsetX: Type.Optional(Type.Number()),
      offsetY: Type.Optional(Type.Number()),
    }),
    async execute(_id, params: any) {
      const result = await callApi("POST", "/api/viewport", params);
      return {
        content: [{ type: "text", text: `${summarizeViewport(result)} ${BROWSER_CLIENT_HINT}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "excalidraw_focus_canvas",
    label: "Focus Excalidraw Canvas",
    description: "Fit the current Excalidraw drawing into view before the final screenshot-based quality check.",
    parameters: Type.Object({}),
    async execute() {
      const result = await callApi("POST", "/api/viewport", { scrollToContent: true });
      return {
        content: [{ type: "text", text: `${summarizeViewport(result)} Canvas fitted to visible content for screenshot validation.` }],
        details: result,
      };
    },
  });

  pi.on("session_shutdown", async () => {
    await stopCanvas();
  });
}
