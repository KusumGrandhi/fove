import { describe, expect, it } from "vitest";
import {
  parseLaunchConfigs, pythonConfigs, resolveConfig, stripJsonc, substitute,
} from "../src/shared/launch-config.js";

describe("stripJsonc", () => {
  it("removes a line comment", () => {
    expect(JSON.parse(stripJsonc('{"a":1} // trailing'))).toEqual({ a: 1 });
  });

  it("removes a block comment", () => {
    expect(JSON.parse(stripJsonc('{/* note */"a":1}'))).toEqual({ a: 1 });
  });

  it("keeps // inside a string", () => {
    // The case a regex-based stripper gets wrong.
    expect(JSON.parse(stripJsonc('{"url":"https://example.com"}')))
      .toEqual({ url: "https://example.com" });
  });

  it("keeps /* inside a string", () => {
    expect(JSON.parse(stripJsonc('{"glob":"src/**/*.py"}'))).toEqual({ glob: "src/**/*.py" });
  });

  it("handles an escaped quote before a comment", () => {
    // A Windows path ends in \\", which a naive scanner reads as an open string.
    const text = '{"cwd":"C:\\\\dir\\\\", "x":1} // done';
    expect(JSON.parse(stripJsonc(text))).toEqual({ cwd: "C:\\dir\\", x: 1 });
  });

  it("ignores a quote inside a comment", () => {
    expect(JSON.parse(stripJsonc('{"a":1} // it\'s "quoted"'))).toEqual({ a: 1 });
  });

  it("removes a trailing comma in an object and an array", () => {
    expect(JSON.parse(stripJsonc('{"a":[1,2,],}'))).toEqual({ a: [1, 2] });
  });

  it("keeps line numbers by preserving newlines in a block comment", () => {
    expect(stripJsonc("/*\n\n*/{}").split("\n")).toHaveLength(3);
  });
});

describe("parseLaunchConfigs", () => {
  /** core/.vscode/launch.json, verbatim -- the file this must actually read. */
  const CORE = `{
  // Use IntelliSense to learn about possible attributes.
  // Hover to view descriptions of existing attributes.
  // For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Python Debugger: Flask",
      "type": "debugpy",
      "request": "launch",
      "module": "flask",
      "env": {
        "FLASK_APP": "flask/core/__init__.py",
        "FLASK_DEBUG": "1"
      },
      "args": ["run", "--no-debugger", "--no-reload"],
      "jinja": true,
      "autoStartBrowser": false
    }
  ]
}`;

  it("reads core's real Flask config, comments and all", () => {
    // JSON.parse throws on this file: the comment header is the first thing in it.
    const configs = parseLaunchConfigs(CORE);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.name).toBe("Python Debugger: Flask");
    expect(configs[0]!.module).toBe("flask");
    expect(configs[0]!.args).toEqual(["run", "--no-debugger", "--no-reload"]);
    expect(configs[0]!.env).toEqual({
      FLASK_APP: "flask/core/__init__.py",
      FLASK_DEBUG: "1",
    });
  });

  it("returns nothing for malformed JSON rather than throwing", () => {
    expect(parseLaunchConfigs("{not json")).toEqual([]);
  });

  it("returns nothing when configurations is missing", () => {
    expect(parseLaunchConfigs('{"version":"0.2.0"}')).toEqual([]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseLaunchConfigs("")).toEqual([]);
  });

  it("skips entries without a name or type", () => {
    const text = '{"configurations":[{"name":"ok","type":"debugpy","request":"launch"},{"request":"launch"}]}';
    expect(parseLaunchConfigs(text).map((c) => c.name)).toEqual(["ok"]);
  });
});

describe("pythonConfigs", () => {
  it("accepts both debugpy and the older python type", () => {
    const list = [
      { name: "a", type: "debugpy", request: "launch" },
      { name: "b", type: "python", request: "launch" },
      { name: "c", type: "node", request: "launch" },
    ];
    expect(pythonConfigs(list).map((c) => c.name)).toEqual(["a", "b"]);
  });
});

describe("substitute", () => {
  it("expands workspaceFolder", () => {
    expect(substitute("${workspaceFolder}/a.py", { workspaceFolder: "/w" })).toBe("/w/a.py");
  });

  it("expands the older workspaceRoot spelling", () => {
    expect(substitute("${workspaceRoot}/a", { workspaceFolder: "/w" })).toBe("/w/a");
  });

  it("leaves an unknown variable as written", () => {
    // Emptying it would fail deep in the adapter with no clue why.
    expect(substitute("${env:SECRET}/a", { workspaceFolder: "/w" })).toBe("${env:SECRET}/a");
  });

  it("leaves ${file} alone when no file is open", () => {
    expect(substitute("${file}", { workspaceFolder: "/w" })).toBe("${file}");
  });
});

describe("resolveConfig", () => {
  it("substitutes across program, cwd, args and env", () => {
    const out = resolveConfig(
      {
        name: "x", type: "debugpy", request: "launch",
        program: "${workspaceFolder}/run.py",
        cwd: "${workspaceFolder}",
        args: ["--root", "${workspaceFolder}"],
        env: { P: "${workspaceFolder}/lib" },
      },
      { workspaceFolder: "/w" },
    );
    expect(out.program).toBe("/w/run.py");
    expect(out.cwd).toBe("/w");
    expect(out.args).toEqual(["--root", "/w"]);
    expect(out.env).toEqual({ P: "/w/lib" });
  });

  it("leaves absent fields absent rather than creating empty ones", () => {
    const out = resolveConfig({ name: "x", type: "debugpy", request: "launch" }, { workspaceFolder: "/w" });
    expect(out.program).toBeUndefined();
    expect(out.env).toBeUndefined();
  });
});
