import { mkdtemp, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, expandConfigPath } from "../src/config.ts";
import { SHARED_PROFILE_ENV, SHARED_PROFILE_SCOPE, SHARED_PROFILE_SCOPE_ENV } from "../index.ts";
import { createProfileFile, renderSeatbeltProfile, type ProfileFile } from "../src/seatbelt.ts";

let profile: ProfileFile | undefined;
afterEach(async () => {
  await profile?.dispose();
  profile = undefined;
});

describe("shared profile contract", () => {
  it("publishes a versioned tool-subprocess scope", () => {
    expect(SHARED_PROFILE_ENV).toBe("PI_SEATBELT_PROFILE");
    expect(SHARED_PROFILE_SCOPE_ENV).toBe("PI_SEATBELT_PROFILE_SCOPE");
    expect(SHARED_PROFILE_SCOPE).toBe("tool-subprocess-v1");
  });
});

describe("renderSeatbeltProfile", () => {
  it("places deny rules after filesystem allows", () => {
    const text = renderSeatbeltProfile({ readable: ["/tmp"], writable: ["/tmp"], denyRead: ["/tmp/secret"], denyWrite: ["/tmp/.env"], network: "none" });
    expect(text.indexOf("(allow file-read*")).toBeGreaterThan(-1);
    expect(text.indexOf("(deny file-read*")).toBeGreaterThan(text.indexOf("(allow file-read*"));
    expect(text.indexOf("(deny file-write*")).toBeGreaterThan(text.indexOf("(allow file-write*"));
  });

  it("quotes paths and omits empty list rules", () => {
    const text = renderSeatbeltProfile({ readable: ["/tmp/path with spaces/quote\"x"], writable: [], denyRead: [], denyWrite: [], network: "all" });
    expect(text).toContain("path with spaces/quote\\\"x");
    expect(text).not.toContain("(allow file-write*\n)");
    expect(text).toContain("(allow network*)");
  });

  it("omits only documented glob paths from the OS profile", () => {
    const text = renderSeatbeltProfile({ readable: ["/tmp/**/*.pem"], writable: [], denyRead: ["/tmp/*.key"], denyWrite: ["/tmp/archive[old]"], network: "none" });
    expect(text).not.toContain("*.pem");
    expect(text).not.toContain("*.key");
    expect(text).toContain("/tmp/archive[old]");
  });

  it("renders profile-directory protection after user filesystem rules", () => {
    const text = renderSeatbeltProfile({ readable: ["/tmp"], writable: ["/tmp"], denyRead: [], denyWrite: ["/tmp/.env"], network: "none" }, "/tmp/pi-seatbelt-private");
    const configuredDeny = text.indexOf("/tmp/.env");
    const profileDeny = text.lastIndexOf("(deny file-write*");
    const profileDirectory = text.indexOf("/tmp/pi-seatbelt-private");

    expect(profileDeny).toBeGreaterThan(text.indexOf("(allow file-write*"));
    expect(profileDeny).toBeGreaterThan(configuredDeny);
    expect(profileDirectory).toBeGreaterThan(profileDeny);
  });
});

describe("config path expansion", () => {
  it("allows full Xcode installs for macOS developer-tool shims", () => {
    expect(DEFAULT_CONFIG.readable).toContain("/Applications/Xcode.app");
  });

  it("expands known variables and rejects unknown variables", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "seatbelt-test-"));
    expect(expandConfigPath("${WORKSPACE}/src", { cwd })).toMatch(/seatbelt-test-.+\/src$/);
    expect(() => expandConfigPath("${NOPE}/x", { cwd })).toThrow(ConfigError);
  });
});

describe("profile lifecycle", () => {
  it("creates a private temp profile and disposes it", async () => {
    profile = await createProfileFile({ readable: ["/tmp"], writable: [], denyRead: [], denyWrite: [], network: "none" });
    expect(existsSync(profile.path)).toBe(true);
    expect(readFileSync(profile.path, "utf8")).toContain("(deny default)");
    const fileMode = (await stat(profile.path)).mode & 0o777;
    const dirMode = (await stat(profile.path.replace(/\/profile\.sb$/, ""))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
    const dir = profile.path.replace(/\/profile\.sb$/, "");
    await profile.dispose();
    profile = undefined;
    expect(existsSync(dir)).toBe(false);
  });
});
