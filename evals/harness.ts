import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chatCompletion } from "../llm";
import { runRoutingSuite } from "./judges/routing-judge";
import { runResumeSuite } from "./judges/resume-judge";
import { runInterviewSuite } from "./judges/interview-judge";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPORTS_DIR = path.join(__dirname, "reports");
const DATASETS_DIR = path.join(__dirname, "datasets");

type SuiteName = "routing" | "resume" | "interview";

function parseArgs() {
  const args = process.argv.slice(2);
  const suite = (args.find(a => a.startsWith("--suite="))?.split("=")[1] || "routing") as SuiteName;
  const n = Number(args.find(a => a.startsWith("--n="))?.split("=")[1] || "0") || 0;
  return { suite, n };
}

function loadJsonl<T = any>(file: string, n = 0): T[] {
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  const items = lines.map(l => JSON.parse(l) as T);
  return n > 0 ? items.slice(0, n) : items;
}

async function main() {
  const { suite, n } = parseArgs();
  mkdirSync(REPORTS_DIR, { recursive: true });

  console.log(`\n=== PawPals Eval — suite=${suite} n=${n || "all"} ===\n`);

  let report: any;
  if (suite === "routing") {
    const cases = loadJsonl(path.join(DATASETS_DIR, "routing-cases.jsonl"), n);
    report = await runRoutingSuite(cases);
  } else if (suite === "resume") {
    const cases = loadJsonl(path.join(DATASETS_DIR, "resume-cases.jsonl"), n);
    report = await runResumeSuite(cases, chatCompletion);
  } else if (suite === "interview") {
    const cases = loadJsonl(path.join(DATASETS_DIR, "interview-cases.jsonl"), n);
    report = await runInterviewSuite(cases, chatCompletion);
  } else {
    console.error(`unknown suite: ${suite}`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(REPORTS_DIR, `${stamp}-${suite}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log("\n--- Summary ---");
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`\nReport: ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
