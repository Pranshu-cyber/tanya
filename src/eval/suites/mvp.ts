import type { EvalSuite, EvalTask } from "../schemas";

type MvpTaskSpec = {
  id: string;
  title: string;
  prompt: string;
  expectedFiles: string[];
  capMinutes: number;
  capUsd: number;
};

const tasks: MvpTaskSpec[] = [
  {
    id: "mvp-01",
    title: "Python todo CLI",
    prompt: [
      "Build a one-file Python todo CLI with add, list, done, and delete commands.",
      "Persist tasks to a JSON file in the project directory.",
      "Include a short README with example commands.",
      "Verify it by running at least one add/list/done/delete flow.",
    ].join(" "),
    expectedFiles: ["todo.py", "README.md"],
    capMinutes: 5,
    capUsd: 0.05,
  },
  {
    id: "mvp-02",
    title: "Express notes REST API",
    prompt: [
      "Build a Node.js Express REST API for an in-memory notes resource.",
      "Implement GET /notes, POST /notes, PUT /notes/:id, and DELETE /notes/:id.",
      "Include package.json, server code, and README.md with curl examples.",
      "Use a conventional startup shape: export the Express app from src/server.js as module.exports/app/default, and only call app.listen when the file is run directly.",
      "Verify the app can start and the routes are wired.",
    ].join(" "),
    expectedFiles: ["package.json", "src/server.js", "README.md"],
    capMinutes: 10,
    capUsd: 0.10,
  },
  {
    id: "mvp-03",
    title: "Hacker News top stories scraper",
    prompt: [
      "Build a Python script that scrapes today's top 10 stories from news.ycombinator.com into stories.json.",
      "Use requests and beautifulsoup4.",
      "Include requirements.txt and README.md.",
      "If dependency install or live network access fails twice, pivot to a deterministic local mock fallback, still write stories.json, and document mock versus live behavior in README.md.",
      "Verify the script runs or document the exact network limitation if the live request is unavailable.",
    ].join(" "),
    expectedFiles: ["hn_top.py", "requirements.txt", "README.md", "stories.json"],
    capMinutes: 5,
    capUsd: 0.05,
  },
  {
    id: "mvp-04",
    title: "Static landing page",
    prompt: [
      "Build a static landing page using index.html and Tailwind via CDN.",
      "Include a hero, features section, pricing section, and footer.",
      "No build step. Keep it polished and readable.",
      "Verify the HTML is self-contained.",
    ].join(" "),
    expectedFiles: ["index.html"],
    capMinutes: 10,
    capUsd: 0.10,
  },
  {
    id: "mvp-05",
    title: "Python curses Snake game",
    prompt: [
      "Build a simple terminal Snake game in Python using curses.",
      "Include movement, food spawning, score display, collision handling, and graceful quit.",
      "Keep it in one file plus README.md.",
      "Verify syntax without requiring an interactive terminal.",
    ].join(" "),
    expectedFiles: ["snake.py", "README.md"],
    capMinutes: 15,
    capUsd: 0.15,
  },
  {
    id: "mvp-06",
    title: "JSON to CSV converter",
    prompt: [
      "Use the provided data/input.json fixture.",
      "Build a Python converter using pandas that writes output.csv with columns id,name,email,plan.",
      "Include requirements.txt and README.md.",
      "Verify the converter runs and output.csv has the expected header and row count.",
    ].join(" "),
    expectedFiles: ["convert.py", "requirements.txt", "README.md", "output.csv"],
    capMinutes: 5,
    capUsd: 0.05,
  },
  {
    id: "mvp-07",
    title: "Rust prime CLI",
    prompt: [
      "Build a Rust CLI that answers whether an integer is prime.",
      "Use cargo init or equivalent project structure.",
      "Support cargo run -- 17 and cargo run -- 18.",
      "Verify with cargo run and include README.md examples.",
    ].join(" "),
    expectedFiles: ["Cargo.toml", "src/main.rs", "README.md"],
    capMinutes: 10,
    capUsd: 0.10,
  },
  {
    id: "mvp-08",
    title: "Vitest fizzbuzz tests",
    prompt: [
      "The project already contains src/fizzbuzz.js.",
      "Write at least 5 Vitest unit tests covering fizz, buzz, fizzbuzz, normal numbers, and edge behavior.",
      "Add package.json if needed and verify npm test passes.",
      "Do not rewrite the implementation unless a test proves it is necessary.",
    ].join(" "),
    expectedFiles: ["src/fizzbuzz.js", "package.json"],
    capMinutes: 5,
    capUsd: 0.05,
  },
  {
    id: "mvp-09",
    title: "Fix Python stats bug",
    prompt: [
      "Fix the known bug in stats.py.",
      "The current script has an off-by-one error and does not handle None values.",
      "Make the smallest reasonable change, add or update tests if useful, and verify python stats.py runs successfully.",
    ].join(" "),
    expectedFiles: ["stats.py"],
    capMinutes: 5,
    capUsd: 0.05,
  },
  {
    id: "mvp-10",
    title: "Commander TypeScript CLI",
    prompt: [
      "Build a slash-command-style CLI tool in TypeScript using commander.",
      "Subcommands: init, add <item>, list, remove <id>.",
      "Persist data to a local JSON file.",
      "Use a conventional startup shape: export the Commander program from src/index.ts and call program.parse only when run as the CLI entry.",
      "Include package.json, tsconfig.json, source code, README.md, and verify the CLI commands run.",
    ].join(" "),
    expectedFiles: ["package.json", "tsconfig.json", "src/index.ts", "README.md"],
    capMinutes: 15,
    capUsd: 0.15,
  },
];

export function mvpSuite(): EvalSuite {
  return {
    name: "mvp",
    version: "2026-05",
    tasks: tasks.map(toEvalTask),
  };
}

function toEvalTask(task: MvpTaskSpec): EvalTask {
  return {
    id: task.id,
    repo_setup: { type: "local_fixture", path: `src/eval/suites/mvp-fixtures/${task.id}` },
    prompt: [
      task.prompt,
      "",
      "First-time-user MVP validation criteria:",
      `- Expected files: ${task.expectedFiles.join(", ")}`,
      `- Soft cap: ${task.capMinutes} minutes / $${task.capUsd.toFixed(2)}.`,
      "- Prefer simple, conventional code over clever abstractions.",
      "- Run the most relevant local verification command before finalizing.",
      "- Final report must state what was built, how it was verified, and any limitations.",
    ].join("\n"),
    expected_files: task.expectedFiles,
    verifier_extension: `src/eval/suites/mvp-fixtures/${task.id}/verify.md`,
    metadata: {
      title: task.title,
      capMinutes: task.capMinutes,
      capUsd: task.capUsd,
      perspective: "first-time-community-user",
    },
  };
}
