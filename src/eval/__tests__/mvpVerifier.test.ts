import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMvpVerifier } from "../mvpVerifier";

describe("MVP verifier extensions", () => {
  it("verifies a conventional Express notes API fixture", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tanya-mvp-express-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "express"), { recursive: true });
    await writeFile(join(workspace, "package.json"), JSON.stringify({ dependencies: { express: "^5.0.0" } }));
    await writeFile(join(workspace, "node_modules", "express", "index.js"), `
const http = require("http");
function express() {
  const routes = [];
  const app = {
    use() {},
    get(path, handler) { routes.push({ method: "GET", path, handler }); },
    post(path, handler) { routes.push({ method: "POST", path, handler }); },
    put(path, handler) { routes.push({ method: "PUT", path, handler }); },
    delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    listen(port, host, cb) {
      if (typeof host === "function") { cb = host; host = "127.0.0.1"; }
      return http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          req.body = body ? JSON.parse(body) : {};
          const route = routes.find((item) => {
            const pattern = new RegExp("^" + item.path.replace(/:[^/]+/g, "([^/]+)") + "$");
            const match = pattern.exec(req.url);
            if (!match || item.method !== req.method) return false;
            req.params = item.path.includes(":id") ? { id: match[1] } : {};
            return true;
          });
          if (!route) { res.statusCode = 404; res.end("{}"); return; }
          res.status = (code) => { res.statusCode = code; return res; };
          res.json = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
          res.end = res.end.bind(res);
          route.handler(req, res);
        });
      }).listen(port, host, cb);
    },
  };
  return app;
}
express.json = () => () => {};
module.exports = express;
`);
    await writeFile(join(workspace, "src", "server.js"), `
const express = require("express");
const app = express();
app.use(express.json());
let nextId = 1;
const notes = [];
app.get("/notes", (_req, res) => res.json(notes));
app.post("/notes", (req, res) => {
  const note = { id: nextId++, title: req.body.title, content: req.body.content };
  notes.push(note);
  res.status(201).json(note);
});
app.put("/notes/:id", (req, res) => {
  const note = notes.find((item) => item.id === Number(req.params.id));
  if (!note) return res.status(404).json({ error: "not found" });
  Object.assign(note, req.body);
  res.json(note);
});
app.delete("/notes/:id", (req, res) => {
  const index = notes.findIndex((item) => item.id === Number(req.params.id));
  if (index === -1) return res.status(404).json({ error: "not found" });
  notes.splice(index, 1);
  res.status(204).end();
});
module.exports = app;
if (require.main === module) app.listen(process.env.PORT || 3000);
`);

    const result = await runMvpVerifier("mvp-02", workspace, process.cwd());

    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });

  it("verifies a Commander-style CLI and accepts documented negative-path failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tanya-mvp-commander-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "package.json"), JSON.stringify({ dependencies: { commander: "^14.0.0" } }));
    await writeFile(join(workspace, "src", "index.js"), `
const fs = require("fs");
const { Command } = require("commander");
const program = new Command();
const store = ".mvp10/data.json";
function readItems() {
  try { return JSON.parse(fs.readFileSync(store, "utf8")); } catch { return []; }
}
function writeItems(items) {
  fs.mkdirSync(".mvp10", { recursive: true });
  fs.writeFileSync(store, JSON.stringify(items, null, 2));
}
program.command("init").action(() => { writeItems([]); console.log("initialized"); });
program.command("add <item>").action((item) => {
  const items = readItems();
  items.push({ id: items.length + 1, item });
  writeItems(items);
  console.log("added");
});
program.command("list").action(() => {
  for (const item of readItems()) console.log(item.id + ": " + item.item);
});
program.command("remove <id>").action((id) => {
  const items = readItems();
  const next = items.filter((item) => item.id !== Number(id));
  if (next.length === items.length) {
    console.error("item not found");
    process.exit(1);
  }
  writeItems(next);
  console.log("removed");
});
module.exports = { program };
if (require.main === module) program.parse(process.argv);
`);

    const result = await runMvpVerifier("mvp-10", workspace, process.cwd());

    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });
});
