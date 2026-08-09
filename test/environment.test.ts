import { describe, expect, it } from "vitest";
import { buildSandboxEnvironment } from "../src/environment.ts";

describe("sandbox environment policy", () => {
  it("preserves inherited values in inherit mode", () => {
    const source = { SEATBELT_PUBLIC_VALUE: "visible", SEATBELT_SECRET_VALUE: "hidden", EMPTY: "" };
    const result = buildSandboxEnvironment(source, { mode: "inherit", deny: ["SEATBELT_SECRET_VALUE"] });

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
  });

  it("removes only exact denied names in filtered mode", () => {
    const source = {
      SEATBELT_PUBLIC_VALUE: "visible",
      SEATBELT_SECRET_VALUE: "hidden",
      SEATBELT_SECRET_VALUE_EXTRA: "still-visible",
      EMPTY: "",
    };
    const result = buildSandboxEnvironment(source, {
      mode: "filtered",
      deny: ["SEATBELT_SECRET_VALUE", "MISSING_VALUE"],
    });

    expect(result).toEqual({
      SEATBELT_PUBLIC_VALUE: "visible",
      SEATBELT_SECRET_VALUE_EXTRA: "still-visible",
      EMPTY: "",
    });
    expect(source.SEATBELT_SECRET_VALUE).toBe("hidden");
  });
});
