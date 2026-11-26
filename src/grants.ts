import { createHash } from "node:crypto";
import { join } from "node:path";
import { canon } from "./policy.ts";

export const GRANT_STORE_VERSION = 1;

export type GrantKind = "read" | "write" | "network";

interface GrantBase {
  id: string;
  createdAt: string;
  expiresAt: string | null;
}

export type Grant =
  | (GrantBase & { kind: "read"; path: string })
  | (GrantBase & { kind: "write"; path: string })
  | (GrantBase & { kind: "network"; mode: "localhost" | "all" });

export interface GrantStoreFile {
  version: number;
  projectRoot: string;
  grants: Grant[];
}

/**
 * Location of the per-project grant store. The store path is a security
 * boundary, so it is derived here and nowhere else: the file name is the
 * sha256 of the canonical project root, keeping one file per project without
 * leaking path text into a shared directory.
 */
export function grantStorePath(agentDir: string, projectRoot: string): string {
  const digest = createHash("sha256").update(canon(projectRoot)).digest("hex");
  return join(agentDir, "extensions", "seatbelt-grants", `${digest}.json`);
}
