import fs from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { SqliteDatabase } from "./db/sqlite.js";
import {
  GRAPH_COVERAGE_LIMITS, graphCorpusPolicyHash, OTHER_KNOWN_SOURCE_EXTENSIONS,
  unindexedExtensionHistogram, type GraphCoverageHistogram,
} from "./corpus-policy.js";
import { isSupportedSourceFile } from "./extraction/grammars.js";

export const GRAPH_COVERAGE_METADATA_KEY = "unindexed_source_coverage";
export const COVERAGE_CACHE_LIMITS = Object.freeze({ directories: 2048, entries: 100_000, bytes: 512 * 1024 });
type DirectoryStamp = { path: string; stamp: string };
interface CoverageCache {
  version: 1;
  policy: string;
  histogram: GraphCoverageHistogram;
  directories: DirectoryStamp[];
}

function directoryStamp(root: string, path: string): string {
  const absolute = resolve(root, path);
  const canonical = fs.realpathSync(absolute);
  const rel = relative(fs.realpathSync(root), canonical);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("Outside coverage root");
  const stats = fs.lstatSync(absolute, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Not a coverage directory");
  return [stats.dev, stats.ino, stats.mtimeNs, stats.ctimeNs].join(":");
}

function policy(root: string): string {
  return JSON.stringify([graphCorpusPolicyHash(root), [...OTHER_KNOWN_SOURCE_EXTENSIONS]
    .filter((extension) => !isSupportedSourceFile(`source${extension}`))]);
}

/** Build-only observation. Directory entry changes invalidate counts without a read-time walk. */
export function captureGraphCoverage(root: string): string {
  const directories = new Map<string, string>();
  let entries = 0;
  let failed = false;
  const readdirSync: typeof fs.readdirSync = ((path: fs.PathLike, options: unknown) => {
    try {
      if (failed) throw new Error("Coverage observation already stopped");
      const rel = relative(resolve(root), String(path)).split("\\").join("/") || ".";
      if (!directories.has(rel) && directories.size >= COVERAGE_CACHE_LIMITS.directories) throw new Error("Directory cap");
      const before = directoryStamp(root, rel);
      // Glob requests Dirents. Stream the directory so even one huge directory
      // cannot allocate an unbounded readdir array before the limit is checked.
      if (!(options as { withFileTypes?: boolean })?.withFileTypes) throw new Error("Unexpected directory options");
      const result: fs.Dirent[] = [];
      const directory = fs.opendirSync(path);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++entries > COVERAGE_CACHE_LIMITS.entries) throw new Error("Entry cap");
          result.push(entry);
        }
      } finally { directory.closeSync(); }
      if (before !== directoryStamp(root, rel)) throw new Error("Directory changed");
      directories.set(rel, before);
      return result;
    } catch (error) {
      failed = true;
      throw error;
    }
  }) as typeof fs.readdirSync;
  try {
    const histogram = unindexedExtensionHistogram(root, GRAPH_COVERAGE_LIMITS, { ...fs, readdirSync });
    if (failed || directories.size === 0) return "null";
    const cache: CoverageCache = {
      version: 1, policy: policy(root), histogram,
      directories: [...directories].map(([path, stamp]) => ({ path, stamp })),
    };
    if (!cache.directories.every((entry) => directoryStamp(root, entry.path) === entry.stamp)) return "null";
    const raw = JSON.stringify(cache);
    return Buffer.byteLength(raw) <= COVERAGE_CACHE_LIMITS.bytes ? raw : "null";
  } catch { return "null"; }
}

/** Legacy indexes have no coverage observation; distinguish them from an invalidated cache. */
export function hasGraphCoverageCache(db: SqliteDatabase): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM project_metadata WHERE key = ?").get(GRAPH_COVERAGE_METADATA_KEY));
  } catch { return false; }
}

/** No discovery, source reads, or writes. Unknown/stale/degraded coverage never yields an exact total. */
export function readGraphCoverage(db: SqliteDatabase, root: string, fresh: boolean): GraphCoverageHistogram | null {
  if (!fresh) return null;
  try {
    const row = db.prepare("SELECT value FROM project_metadata WHERE key = ? AND length(CAST(value AS BLOB)) <= ?")
      .get(GRAPH_COVERAGE_METADATA_KEY, COVERAGE_CACHE_LIMITS.bytes) as { value?: unknown } | undefined;
    if (typeof row?.value !== "string" || Buffer.byteLength(row.value) > COVERAGE_CACHE_LIMITS.bytes) return null;
    const cache = JSON.parse(row.value) as CoverageCache | null;
    if (!cache || cache.version !== 1 || cache.policy !== policy(root)
      || !Array.isArray(cache.directories) || cache.directories.length === 0
      || cache.directories.length > COVERAGE_CACHE_LIMITS.directories) return null;
    const histogram = cache.histogram;
    if (!histogram || !Number.isSafeInteger(histogram.total) || histogram.total < 0
      || histogram.total > GRAPH_COVERAGE_LIMITS.maxUnindexedFiles || typeof histogram.truncated !== "boolean"
      || !Array.isArray(histogram.entries) || histogram.entries.length > GRAPH_COVERAGE_LIMITS.maxUnindexedEntries) return null;
    const extensions = new Set<string>();
    let sum = 0;
    for (const entry of histogram.entries) {
      if (!entry || !OTHER_KNOWN_SOURCE_EXTENSIONS.has(entry.extension) || extensions.has(entry.extension)
        || isSupportedSourceFile(`source${entry.extension}`) || !Number.isSafeInteger(entry.files) || entry.files <= 0) return null;
      extensions.add(entry.extension);
      sum += entry.files;
    }
    if (sum > histogram.total || (histogram.total > 0 && sum === 0)) return null;
    const paths = new Set<string>();
    for (const entry of cache.directories) {
      if (!entry || typeof entry.path !== "string" || entry.path.length > 4096
        || (entry.path !== "." && (!entry.path || entry.path.startsWith("/") || entry.path.includes("\\")
          || entry.path.includes(":") || entry.path.split("/").some((part) => !part || part === "." || part === "..")))
        || paths.has(entry.path) || typeof entry.stamp !== "string" || !/^\d+:\d+:\d+:\d+$/u.test(entry.stamp)) return null;
      paths.add(entry.path);
      if (directoryStamp(root, entry.path) !== entry.stamp) return null;
    }
    if (!paths.has(".")) return null;
    return histogram;
  } catch { return null; }
}

/** Caller supplies its existing status observation; immutable open validates the store again. */
export async function readStoredGraphCoverage(root: string, fresh: boolean): Promise<GraphCoverageHistogram | null> {
  if (!fresh) return null;
  try {
    const { openImmutableGraphReadSessionSync } = await import("./read-session.js");
    const session = openImmutableGraphReadSessionSync(root, resolve(root, ".mex", "graph.db"));
    try {
      const coverage = readGraphCoverage(session.db, root, true);
      return session.validate().valid ? coverage : null;
    } finally { session.close(); }
  } catch { return null; }
}

export function coverageFields(coverage: GraphCoverageHistogram | null): Record<string, unknown> {
  return coverage && (coverage.total > 0 || coverage.truncated) ? {
    unindexedSources: {
      total: coverage.total,
      byExtension: Object.fromEntries(coverage.entries.map((entry) => [entry.extension, entry.files])),
      truncated: coverage.truncated,
    },
  } : {};
}
