import { mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertCanRead, assertCanWrite, buildPolicy, canon, isInside } from "../src/policy.ts";

describe("path policy", () => {
  it("checks inside boundaries without prefix confusion", () => {
    expect(isInside("/foo/bar", "/foo")).toBe(true);
    expect(isInside("/foo", "/foo")).toBe(true);
    expect(isInside("/foobar", "/foo")).toBe(false);
  });

  it("lets deny rules beat allow rules", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-policy-"));
    const policy = buildPolicy({ readable: [root], writable: [root], denyRead: [join(root, "secret")], denyWrite: [join(root, ".env")] }, root);
    expect(() => assertCanRead(join(root, "secret", "x"), policy)).toThrow(/denied/);
    expect(() => assertCanWrite(join(root, ".env"), policy)).toThrow(/denied/);
    expect(() => assertCanRead(join(root, "ok"), policy)).not.toThrow();
  });

  it("blocks symlink-parent escapes for non-existent write targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-root-"));
    const outside = mkdtempSync(join(tmpdir(), "seatbelt-outside-"));
    await symlink(outside, join(root, "link"));
    const policy = buildPolicy({ readable: [root], writable: [root], denyRead: [], denyWrite: [] }, root);
    expect(canon(join(root, "link", "new.txt"))).toMatch(/seatbelt-outside-.+\/new\.txt$/);
    expect(() => assertCanWrite(join(root, "link", "new.txt"), policy)).toThrow(/outside allowed roots/);
  });

  it("matches deny globs against canonical paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-glob-"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "key.pem"), "secret");
    const policy = buildPolicy({ readable: [root], writable: [root], denyRead: [join(root, "**", "*.pem")], denyWrite: [join(root, ".env.*")] }, root);
    expect(() => assertCanRead(join(root, "nested", "key.pem"), policy)).toThrow(/denied/);
    expect(() => assertCanWrite(join(root, ".env.local"), policy)).toThrow(/denied/);
  });

  it("matches readable/writable glob allows exactly instead of granting the non-glob prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-allowglob-"));
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export {};\n");
    await writeFile(join(root, "src", "nested", "file.ts"), "export {};\n");
    await writeFile(join(root, "src", "other.txt"), "nope\n");
    const policy = buildPolicy({ readable: [join(root, "src", "**", "*.ts")], writable: [join(root, "src", "**", "*.ts")], denyRead: [], denyWrite: [] }, root);

    expect(() => assertCanRead(join(root, "src", "index.ts"), policy)).not.toThrow();
    expect(() => assertCanRead(join(root, "src", "nested", "file.ts"), policy)).not.toThrow();
    expect(() => assertCanWrite(join(root, "src", "nested", "new.ts"), policy)).not.toThrow();
    expect(() => assertCanRead(join(root, "src", "other.txt"), policy)).toThrow(/outside allowed roots/);
    expect(() => assertCanWrite(join(root, "src", "other.txt"), policy)).toThrow(/outside allowed roots/);
    expect(() => assertCanRead(join(root, "outside.ts"), policy)).toThrow(/outside allowed roots/);
  });
});
