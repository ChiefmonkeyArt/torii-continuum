// Trial clanker: reads decrypted Cordn inbox jobs, acts only on authorised
// human senders, opens an ngit PR (never merges), and replies via the outbox.
// Deterministic on purpose — this tests the plumbing and trust boundaries,
// not a model. A real clanker would put an LLM where `makeChange` is.
import { readdirSync, renameSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = "/tmp/trial/state/clanker";
const INBOX = join(ROOT, "inbox"), OUTBOX = join(ROOT, "outbox");
const SEEN = join(ROOT, "seen.log");
const WORK = "/tmp/trial/work/clanker";
const GROUP = "torii-team";
const REPO_URL = process.env.REPO_URL;              // nostr://<owner-npub>/<id>
const HUMANS = new Set(process.env.HUMANS.split(",")); // roster humans (hex)
const MAX_PER_MIN = 3;
const env = { ...process.env, HOME: "/tmp/trial/home/clanker" };

const seen = new Set(existsSync(SEEN) ? readFileSync(SEEN, "utf8").split("\n").filter(Boolean) : []);
let recent = [];

function reply(message) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tmp = join(OUTBOX, `${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ groupAlias: GROUP, message }), { mode: 0o600 });
  renameSync(tmp, join(OUTBOX, `${id}.json`));
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeChange(task, dir) {
  // Stand-in for model output: write the requested note into TEAM_NOTES.md.
  appendFileSync(join(dir, "TEAM_NOTES.md"), `- ${task}\n`);
}

function handle(job) {
  const key = `${job.groupAlias}:${job.cursor}:${job.id}`;
  if (seen.has(key)) return "duplicate";
  appendFileSync(SEEN, key + "\n"); seen.add(key);           // persist dedupe first
  if (job.groupAlias !== GROUP) return "wrong group";
  if (!HUMANS.has(job.sender)) return `ignored sender ${job.sender.slice(0, 8)}`; // no bot loops, no outsiders
  const m = /^@clanker\s+note:\s*(.{1,200})$/s.exec(job.content ?? "");
  if (!m) return "not addressed";
  const now = Date.now(); recent = recent.filter(t => now - t < 60_000);
  if (recent.length >= MAX_PER_MIN) { reply("Rate limit reached; try again in a minute."); return "rate limited"; }
  recent.push(now);
  const task = m[1].replace(/[\r\n]+/g, " ").trim();
  const branch = `pr/clanker-${job.cursor}`;
  const dir = join(WORK, `c${job.cursor}`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });
  sh("git", ["clone", "-q", REPO_URL, dir]);
  sh("git", ["checkout", "-q", "-b", branch], dir);
  makeChange(task, dir);
  sh("git", ["add", "TEAM_NOTES.md"], dir);
  sh("git", ["-c", "user.name=trial-clanker", "-c", "user.email=clanker@trial.invalid", "commit", "-q", "-m", `docs: add team note (requested by ${job.sender.slice(0, 8)})`], dir);
  const out = sh("git", ["push", "-o", `title=Team note from chat #${job.cursor}`, "-o", `description=Requested in Cordn group ${GROUP} by ${job.sender}. Agent-authored; needs a human maintainer to merge.`, "-u", "origin", branch], dir);
  reply(`Opened PR ${branch} for review (agent-authored, not merged).`);
  return `PR pushed: ${branch}\n${out.split("\n").slice(-3).join("\n")}`;
}

for (;;) {
  for (const f of readdirSync(INBOX).filter(f => f.endsWith(".json")).sort()) {
    const claimed = join(INBOX, `${f}.claimed`);
    try { renameSync(join(INBOX, f), claimed); } catch { continue; }
    let result;
    try { result = handle(JSON.parse(readFileSync(claimed, "utf8"))); }
    catch (e) { result = `error: ${String(e.stderr || e.message).slice(0, 400)}`; }
    console.log(new Date().toISOString(), f, "->", result);
    rmSync(claimed);
  }
  await new Promise(r => setTimeout(r, 1000));
}
