export type ProjectTemplate = "empty" | "node" | "python";

/** Minimal, honest starting points for a new project. Nothing that pretends to be a real app. */
export function templateFiles(name: string, template: ProjectTemplate, goal: string | null): Record<string, string> {
  const readme = [`# ${name}`, "", goal ?? "Describe what this project is for.", "", 'Created with DEV. Plan the first milestone with `dev plan "<goal>"` or the Plan dialog.', ""].join("\n");
  const gitignore = ["node_modules/", "dist/", "build/", ".env", ".env.*", "!.env.example", "__pycache__/", ".venv/", "*.log", ".dev-home/", ""].join("\n");
  if (template === "node") {
    return {
      "README.md": readme,
      ".gitignore": gitignore,
      "package.json": JSON.stringify({ name, version: "0.1.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
      "src/index.js": ['export function hello(name = "world") {', "  return `Hello, ${name}!`;", "}", ""].join("\n"),
      "test/index.test.js": ['import assert from "node:assert/strict";', 'import { test } from "node:test";', 'import { hello } from "../src/index.js";', "", 'test("hello greets", () => {', '  assert.equal(hello("DEV"), "Hello, DEV!");', "});", ""].join("\n"),
    };
  }
  if (template === "python") {
    return {
      "README.md": readme,
      ".gitignore": gitignore,
      "main.py": ['def hello(name: str = "world") -> str:', '    return f"Hello, {name}!"', "", "", 'if __name__ == "__main__":', "    print(hello())", ""].join("\n"),
      "test_main.py": ["import unittest", "", "from main import hello", "", "", "class HelloTest(unittest.TestCase):", "    def test_hello(self):", '        self.assertEqual(hello("DEV"), "Hello, DEV!")', "", "", 'if __name__ == "__main__":', "    unittest.main()", ""].join("\n"),
    };
  }
  return { "README.md": readme, ".gitignore": gitignore };
}
