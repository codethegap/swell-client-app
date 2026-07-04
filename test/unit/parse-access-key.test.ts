import { describe, it, expect } from "vitest";
import { parseAccessKey } from "../../functions/libs/flexiport";

describe("parseAccessKey", () => {
  it("treats a bare value as the access key with no base URL (production default)", () => {
    expect(parseAccessKey("run_abc")).toEqual({ accessKey: "run_abc" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseAccessKey("  run_abc  ")).toEqual({ accessKey: "run_abc" });
  });

  it("appends the default integrations path to a bare origin", () => {
    expect(parseAccessKey("run_abc@http://localhost:3010")).toEqual({
      accessKey: "run_abc",
      baseUrl: "http://localhost:3010/integrations/v1",
    });
  });

  it("appends the default path to an https tunnel origin", () => {
    expect(parseAccessKey("run_abc@https://x.trycloudflare.com")).toEqual({
      accessKey: "run_abc",
      baseUrl: "https://x.trycloudflare.com/integrations/v1",
    });
  });

  it("keeps an explicit path as-is (no double path)", () => {
    expect(parseAccessKey("run_abc@http://localhost:3010/integrations/v1")).toEqual({
      accessKey: "run_abc",
      baseUrl: "http://localhost:3010/integrations/v1",
    });
  });

  it("strips a trailing slash and falls back to the default path", () => {
    expect(parseAccessKey("run_abc@http://localhost:3010/")).toEqual({
      accessKey: "run_abc",
      baseUrl: "http://localhost:3010/integrations/v1",
    });
  });

  it("splits on the FIRST @ so a URL with userinfo stays unambiguous", () => {
    expect(parseAccessKey("run_abc@https://u:p@host.example.com/integrations/v1").accessKey).toBe(
      "run_abc",
    );
  });

  it("throws on an empty value", () => {
    expect(() => parseAccessKey("")).toThrow(/required/i);
    expect(() => parseAccessKey("   ")).toThrow(/required/i);
  });

  it("throws when the access key is missing before @", () => {
    expect(() => parseAccessKey("@http://localhost:3010")).toThrow(/missing before/i);
  });

  it("throws when the base URL is missing after @", () => {
    expect(() => parseAccessKey("run_abc@")).toThrow(/missing after/i);
  });

  it("throws on a non-http(s) protocol", () => {
    expect(() => parseAccessKey("run_abc@ftp://localhost:3010")).toThrow(/http or https/i);
  });

  it("throws on a value that is not a URL", () => {
    expect(() => parseAccessKey("run_abc@not a url")).toThrow(/invalid base url/i);
  });
});
