const crypto = require("node:crypto");

const AGENTS = [
  { name: "Email Marketing Agent", task: "Create audience segments, positioning, subject lines, a complete email draft, follow-up sequence and deliverability checklist." },
  { name: "Leads & CRM Agent", task: "Define ideal lead criteria, qualification rules, CRM fields, pipeline stages and follow-up workflow. Never invent real contacts." },
  { name: "Website & Content Agent", task: "Create landing-page recommendations, SEO keywords, page-copy outline and supporting content ideas." },
  { name: "Campaigns & Sales Agent", task: "Create campaign positioning, offer, sales messaging, channel plan, budget considerations without spending, and launch checklist." },
  { name: "Analytics & Reporting Agent", task: "Define KPIs, tracking plan, reporting template, risks and optimization experiments. Never invent performance data." }
];

function installAgentEngine(db, model) {
  db.exec("CREATE TABLE IF NOT EXISTS agent_jobs (id TEXT PRIMARY KEY, instruction TEXT NOT NULL, status TEXT NOT NULL, results TEXT NOT NULL DEFAULT '[]', finalReport TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)");
  db.exec("UPDATE agent_jobs SET status='queued' WHERE status='running'");
  let busy = false;

  async function ask(prompt) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        instructions: "You are a specialist AI worker for Z 2 Digital. Complete your assigned work. Use Roman Urdu for internal explanations; write client-facing marketing copy in professional English unless requested otherwise. Do not send emails, publish, contact people, spend money, change live systems, or claim access to real data. Prepare deliverables only. State assumptions and missing inputs.",
        input: prompt,
        max_output_tokens: 1100
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || "AI provider request failed");
    return (data.output || []).flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text).join("\n").trim();
  }

  async function processQueue() {
    if (busy || !process.env.OPENAI_API_KEY) return;
    busy = true;
    try {
      let job = db.prepare("SELECT * FROM agent_jobs WHERE status='queued' ORDER BY createdAt ASC LIMIT 1").get();
      while (job) {
        db.prepare("UPDATE agent_jobs SET status='running',updatedAt=? WHERE id=?").run(new Date().toISOString(), job.id);
        const results = [];
        try {
          for (const agent of AGENTS) {
            const previous = results.map(item => item.agent + ":\n" + item.output).join("\n\n");
            const output = await ask("OWNER TASK:\n" + job.instruction + "\n\nYOUR ROLE: " + agent.name + "\nYOUR ASSIGNMENT: " + agent.task + "\n\nCOMPLETED TEAM WORK:\n" + (previous || "You are first. Establish the foundation.") + "\n\nReturn a concrete deliverable with headings, actions and assumptions.");
            results.push({ agent: agent.name, output });
            db.prepare("UPDATE agent_jobs SET results=?,updatedAt=? WHERE id=?").run(JSON.stringify(results), new Date().toISOString(), job.id);
          }
          const finalReport = await ask("You are Owner AI, lead orchestrator. Combine these five specialists' work into one coherent plan. Remove duplication, identify dependencies, list next steps, and flag anything requiring human approval before external action. Never claim anything was sent or published.\nOWNER TASK:\n" + job.instruction + "\n\nTEAM OUTPUTS:\n" + results.map(item => "## " + item.agent + "\n" + item.output).join("\n\n"));
          db.prepare("UPDATE agent_jobs SET status='awaiting_owner_approval',results=?,finalReport=?,updatedAt=? WHERE id=?").run(JSON.stringify(results), finalReport, new Date().toISOString(), job.id);
        } catch (error) {
          db.prepare("UPDATE agent_jobs SET status='failed',results=?,finalReport=?,updatedAt=? WHERE id=?").run(JSON.stringify(results), "Execution error: " + String(error.message || error).slice(0, 500), new Date().toISOString(), job.id);
        }
        job = db.prepare("SELECT * FROM agent_jobs WHERE status='queued' ORDER BY createdAt ASC LIMIT 1").get();
      }
    } finally { busy = false; }
  }

  function enqueue(instruction) {
    const now = new Date().toISOString();
    const job = { id: crypto.randomUUID(), instruction, status: "queued", results: "[]", finalReport: "", createdAt: now, updatedAt: now };
    db.prepare("INSERT INTO agent_jobs (id,instruction,status,results,finalReport,createdAt,updatedAt) VALUES (@id,@instruction,@status,@results,@finalReport,@createdAt,@updatedAt)").run(job);
    setImmediate(processQueue);
    return job;
  }

  function list() {
    return db.prepare("SELECT * FROM agent_jobs ORDER BY createdAt DESC LIMIT 30").all().map(job => ({ ...job, results: JSON.parse(job.results || "[]") }));
  }

  function decide(id, decision) {
    const job = db.prepare("SELECT * FROM agent_jobs WHERE id=?").get(id);
    if (!job) return { error: "Job not found.", status: 404 };
    if (job.status !== "awaiting_owner_approval") return { error: "Only completed jobs can be reviewed.", status: 409 };
    const status = decision === "approved" ? "owner_approved" : "owner_rejected";
    db.prepare("UPDATE agent_jobs SET status=?,updatedAt=? WHERE id=?").run(status, new Date().toISOString(), id);
    return { status: 200, job: { id, status } };
  }

  return { enqueue, list, decide, agents: AGENTS, configured: () => Boolean(process.env.OPENAI_API_KEY) };
}

module.exports = { installAgentEngine };
