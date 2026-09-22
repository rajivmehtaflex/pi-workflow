import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

describe("package distribution contract", () => {
  test("builds the extension when installed from a VCS source", () => {
    expect(manifest.scripts?.prepare).toBe("npm run build");
  });

  test("does not impose an artificial upper bound on Pi host versions", () => {
    expect(manifest.peerDependencies).toMatchObject({
      "@earendil-works/pi-agent-core": ">=0.86.0",
      "@earendil-works/pi-coding-agent": ">=0.86.0",
      "@earendil-works/pi-tui": ">=0.86.0",
    });
  });

  test("ships SQLite declarations for omit-dev lifecycle builds", () => {
    expect(manifest.dependencies?.["@types/better-sqlite3"]).toBe("^7.6.13");
    expect(manifest.devDependencies?.["@types/better-sqlite3"]).toBeUndefined();
  });
});
