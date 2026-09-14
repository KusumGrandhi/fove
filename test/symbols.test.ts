import { describe, expect, test } from "vitest";
import { scanSymbols } from "../src/shared/symbols.js";

const src = (...l: string[]) => l.join("\n");

describe("python", () => {
  const text = src(
    "MAX_RETRIES = 3",
    "",
    "class Runner:",
    "    def __init__(self, cwd):",
    "        self.cwd = cwd",
    "",
    "    async def run(self, cmd):",
    "        local_thing = 1",
    "        return local_thing",
    "",
    "def main():",
    "    pass",
  );

  test("classes hold their methods", () => {
    const syms = scanSymbols("python", text);
    expect(syms.map((s) => s.name)).toEqual(["MAX_RETRIES", "Runner", "main"]);
    const runner = syms.find((s) => s.name === "Runner")!;
    expect(runner.children.map((c) => c.name)).toEqual(["__init__", "run"]);
    expect(runner.children.every((c) => c.kind === "method")).toBe(true);
  });

  test("a top-level def is a function, not a method", () => {
    const main = scanSymbols("python", text).find((s) => s.name === "main")!;
    expect(main.kind).toBe("function");
  });

  test("async is noted", () => {
    const runner = scanSymbols("python", text).find((s) => s.name === "Runner")!;
    expect(runner.children.find((c) => c.name === "run")!.detail).toBe("async");
  });

  test("a class body ends where the next top-level thing starts", () => {
    const runner = scanSymbols("python", text).find((s) => s.name === "Runner")!;
    expect(runner.line).toBe(3);
    expect(runner.endLine).toBe(10);
  });

  test("locals inside a function are not listed as constants", () => {
    const names = scanSymbols("python", text).flatMap(function all(s): string[] {
      return [s.name, ...s.children.flatMap(all)];
    });
    expect(names).not.toContain("local_thing");
  });

  test("a commented-out def is not a symbol", () => {
    expect(scanSymbols("python", "# def ghost():\npass")).toEqual([]);
  });
});

describe("go", () => {
  const text = src(
    "package main",
    "",
    "type Server struct {",
    "\tport int",
    "}",
    "",
    "func (s *Server) Start() error {",
    "\treturn nil",
    "}",
    "",
    "func main() {}",
  );

  test("finds types, methods and functions", () => {
    const syms = scanSymbols("go", text);
    expect(syms.map((s) => [s.name, s.kind])).toEqual([
      ["Server", "struct"],
      ["Start", "method"],
      ["main", "function"],
    ]);
  });

  test("a method carries its receiver type", () => {
    expect(scanSymbols("go", text)[1]!.detail).toBe("Server");
  });
});

describe("rust", () => {
  test("finds declarations through their visibility and modifiers", () => {
    const syms = scanSymbols("rust", src(
      "pub struct Config {}",
      "pub(crate) enum Mode {}",
      "trait Run {}",
      "impl Run for Config {}",
      "pub async fn start() {}",
      "fn helper() {}",
    ));
    expect(syms.map((s) => [s.name, s.kind])).toEqual([
      ["Config", "struct"],
      ["Mode", "enum"],
      ["Run", "trait"],
      ["Config", "module"],
      ["start", "function"],
      ["helper", "function"],
    ]);
    expect(syms[3]!.detail).toBe("impl Run");
  });
});

describe("ruby", () => {
  test("finds modules, classes and methods including predicates", () => {
    const syms = scanSymbols("ruby", src(
      "module Billing",
      "  class Invoice",
      "    def paid?",
      "    end",
      "    def self.build",
      "    end",
      "  end",
      "end",
    ));
    expect(syms.map((s) => s.name)).toEqual(["Billing", "Invoice", "paid?", "build"]);
  });
});

describe("unsupported languages", () => {
  test("get nothing rather than a guess", () => {
    expect(scanSymbols("typescript", "export function x() {}")).toEqual([]);
    expect(scanSymbols("plaintext", "anything")).toEqual([]);
  });
});
