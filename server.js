const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = process.env.DATABASE_PATH || path.join(DATA_DIR, "z2digital.sqlite");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)");
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const loginAttempts = new Map();
const secureCookie = process.env.NODE_ENV === "production";
function parseCookies(header) { const out = {}; for (const part of (header || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim()); } return out; }
function getSession(req) { const token = parseCookies(req.headers.cookie).z2_session; const session = token && sessions.get(token); if (!session || session.expiresAt < Date.now()) { if (token) sessions.delete(token); return null; } session.expiresAt = Date.now() + SESSION_TTL_MS; return session; }
function requireAuth(req,res) { if (getSession(req)) return true; send(res,401,{error:"Please log in to continue."}); return false; }
function taskRows() { return db.prepare("SELECT * FROM tasks ORDER BY createdAt ASC").all(); }

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const SYSTEM_PROMPT = `You are the Z 2 Digital AI Business Operations Director, speaking as the central AI assistant to the owner, visiting company director/sir, students, and team members.
LANGUAGE AND TONE
- At the start of a voice conversation, politely ask whether the speaker prefers Urdu, Roman Urdu, or English. Continue in that language; follow natural language switches. In text chat, mirror the user's language. Be respectful, confident, concise, and clear.
- Explain technical ideas simply to students. Give senior visitors a professional executive-level explanation without exaggeration.
COMPANY MISSION
- Explain that Z 2 Digital is building an AI-supported digital marketing operating model. The human owner remains CEO and decision-maker; AI supports planning, preparation, coordination, quality checks, and reporting.
- If asked whether one person can manage 50 clients with AI support, answer confidently but honestly: it is a realistic operating target when each client has a structured profile, repeatable service workflows, a shared task queue, specialist AI assistance, scheduled reviews, quality checks, and human approval for important actions. AI reduces repetitive work and helps one owner oversee more clients; it does not remove the need for human judgment, client communication, service capacity, and reliable integrations. Never guarantee 50 clients can be handled immediately or without workload.
- Explain the illustrative 50-client workflow: onboard each client; record goals, services, brand voice, channels, deadlines and approvals; create a per-client work queue; assign each task to the relevant specialist; prepare drafts and recommendations; owner reviews high-impact work; record outcomes and prepare weekly client reports. Keep each client's data and work separate.
SPECIALIST TEAM
1. Email Marketing: audience segmentation plans, email copy, sequences, deliverability checklists and follow-ups.
2. Leads & CRM: lead qualification, pipeline design, contact hygiene and follow-up recommendations.
3. Website & Content: landing pages, website copy, SEO, blogs and social content.
4. Campaigns & Sales: campaign strategy, offers, ad concepts, sales scripts and launch checklists.
5. Analytics & Reporting: interpret metrics actually supplied, identify gaps, recommend next steps and prepare reports.
For every request, identify the responsible specialist, describe the handoff, and give a practical output or next step. Multiple specialists may collaborate on a client workflow.
TRUTH AND SAFETY
- Clearly separate what is currently working in this preview from what is a proposed operating capability or future integration. The five specialists are currently defined AI roles coordinated through one assistant, not five independent deployed autonomous agents.
- The current preview can provide AI guidance/drafts when its AI key is configured, save basic tasks, and display the existing voice widget when Vapi is correctly configured. It does not yet provide a full 50-client CRM, autonomous background agent execution, real email sending, live CRM updates, ad publishing, or verified live analytics.
- Never invent clients, revenue, campaign results, integrations, completed work, or metrics. Label sample client scenarios as demonstrations, not real customers.
- Never say an email was sent, CRM changed, ad published, payment collected, or external action completed unless a connected tool confirms it. Prepare drafts and plans only; require explicit human owner approval for external actions.
- If asked for a proposal, client-facing email, website copy, ad, or report, prepare polished professional English by default unless another language is requested. Explain the work to the owner in their chosen language.
- If asked about security or scaling, explain client separation, least-privilege access, backups, monitoring, human approvals, and production database/integration requirements as necessary design controls; do not claim they are already implemented.
- Do not pretend to be the legal CEO or a human employee. You are the AI operations assistant supporting the human CEO.
`;

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20000) throw new Error("Request too large");
  }
  return JSON.parse(raw || "{}");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/auth/session") return send(res,200,{authenticated:Boolean(getSession(req))});
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    try { if(!process.env.OWNER_PASSWORD||!process.env.SESSION_SECRET||process.env.OWNER_PASSWORD.length<12||process.env.SESSION_SECRET.length<32)return send(res,503,{error:"Configure OWNER_PASSWORD (12+ chars) and SESSION_SECRET (32+ chars) privately on hosting."}); const ip=req.socket.remoteAddress||"unknown"; let attempt=loginAttempts.get(ip)||{count:0,until:0}; if(attempt.until>Date.now()&&attempt.count>=8)return send(res,429,{error:"Too many attempts. Try again in 15 minutes."}); const body=await readBody(req); const supplied=typeof body.password==="string"?body.password:""; const expected=crypto.scryptSync(process.env.OWNER_PASSWORD,process.env.SESSION_SECRET,64); const actual=crypto.scryptSync(supplied.slice(0,256),process.env.SESSION_SECRET,64); if(supplied.length>256||!crypto.timingSafeEqual(expected,actual)){attempt={count:attempt.until>Date.now()?attempt.count+1:1,until:Date.now()+900000};loginAttempts.set(ip,attempt);return send(res,401,{error:"Password incorrect."});} loginAttempts.delete(ip); const token=crypto.randomBytes(32).toString("hex"); sessions.set(token,{expiresAt:Date.now()+SESSION_TTL_MS}); res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Set-Cookie":"z2_session="+token+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800"+(secureCookie?"; Secure":"")}); return res.end(JSON.stringify({authenticated:true})); } catch(e) { return send(res,400,{error:"Could not process login."}); }
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/logout"){const token=parseCookies(req.headers.cookie).z2_session;if(token)sessions.delete(token);res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Set-Cookie":"z2_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"+(secureCookie?"; Secure":"")});return res.end(JSON.stringify({authenticated:false}));}
  if((url.pathname==="/api/tasks"||url.pathname.startsWith("/api/tasks/")||url.pathname==="/api/chat")&&!requireAuth(req,res))return;

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, service: "Z 2 Digital AI backend", aiConfigured: Boolean(process.env.OPENAI_API_KEY) });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/update-vapi-assistant") {
    if (!process.env.VAPI_API_KEY || !process.env.VAPI_ASSISTANT_ID || !process.env.WORKSPACE_ADMIN_TOKEN) {
      return send(res, 503, { error: "Vapi setup is incomplete. Configure the Vapi API key, existing assistant ID, and workspace admin token in hosting environment variables." });
    }
    if ((req.headers.authorization || "") !== "Bearer " + process.env.WORKSPACE_ADMIN_TOKEN) return send(res, 401, { error: "Unauthorized." });
    try {
      const endpoint = "https://api.vapi.ai/assistant/" + encodeURIComponent(process.env.VAPI_ASSISTANT_ID);
      const currentResponse = await fetch(endpoint, { headers: { Authorization: "Bearer " + process.env.VAPI_API_KEY } });
      const current = await currentResponse.json();
      if (!currentResponse.ok) return send(res, 502, { error: "Could not retrieve the existing Vapi assistant. Check its ID and API key." });
      const oldMessages = current.model && Array.isArray(current.model.messages) ? current.model.messages : [];
      const otherMessages = oldMessages.filter(message => message.role !== "system");
      const prompt = "You are the Z 2 Digital AI Business Operations Director, supporting the human owner/CEO of Z 2 Digital. At the start of each voice conversation, greet the speaker and ask whether they prefer Urdu, Roman Urdu, or English; consistently use that language and follow language switches. Respectfully adapt to a company director, sir, student, guest, or team member. Explain simply to students and professionally to senior visitors. Explain that the human owner is CEO and you are the AI operations assistant. If asked whether one person can manage 50 clients with AI support, say it is a realistic target with structured client profiles, separated workspaces, repeatable workflows, a shared queue, specialist AI assistance, scheduled reviews, quality checks and human approvals; AI reduces repetitive work but does not guarantee instant capacity or replace human judgment, client communication, service capacity and integrations. Explain a sample workflow: onboard client, record goals/services/brand voice/channels/deadlines/approvals, create per-client task queue, route work to Email Marketing, Leads & CRM, Website & Content, Campaigns & Sales, or Analytics & Reporting, prepare drafts, obtain owner approval, record outcomes and report. Clearly state the current preview has one central assistant and five defined specialist roles, not five independently deployed autonomous agents; it is not yet a full 50-client CRM or background automation platform. Real email sending, CRM updates, ad publishing, live analytics and persistent production data need integrations and testing. Never invent clients, revenue, metrics or completed actions. Never claim an email sent, CRM changed, ad published or payment collected unless a connected tool confirms it. Get explicit human owner approval before external actions. Use polished professional English for client-facing drafts unless requested otherwise. Be confident, practical, concise, and honest.";\n      const patch = { name: "Z 2 Digital AI Assistant", firstMessage: "Assalam-o-alaikum! Welcome to Z 2 Digital. Aap Urdu, Roman Urdu ya English mein baat karna pasand karenge? Main aapki choice ke mutabiq baat karunga." };
      if (current.model) patch.model = Object.assign({}, current.model, { messages: [{ role: "system", content: prompt }].concat(otherMessages) });
      const updatedResponse = await fetch(endpoint, { method: "PATCH", headers: { Authorization: "Bearer " + process.env.VAPI_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const updated = await updatedResponse.json();
      if (!updatedResponse.ok) return send(res, 502, { error: "Vapi rejected the update. Review the assistant settings in Vapi." });
      return send(res, 200, { ok: true, name: updated.name || patch.name, assistantId: updated.id, firstMessage: updated.firstMessage || patch.firstMessage });
    } catch (error) { return send(res, 502, { error: "Could not update the existing Vapi assistant." }); }
  }
  if (req.method === "GET" && url.pathname === "/api/tasks") {
    try { return send(res,200,{tasks:taskRows()}); } catch(e) { return send(res,500,{error:"Could not load task history."}); }
  }
  if (req.method === "POST" && url.pathname === "/api/tasks") {
    try { const body=await readBody(req); const title=typeof body.title==="string"?body.title.trim():""; const agent=typeof body.agent==="string"?body.agent.trim():"Central AI Assistant · Triage"; if(!title)return send(res,400,{error:"Task description is required."}); if(title.length>4000)return send(res,400,{error:"Task description is too long."}); const task={id:crypto.randomUUID(),title,agent,status:"Pending review",result:"",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; db.prepare("INSERT INTO tasks (id,title,agent,status,result,createdAt,updatedAt) VALUES (@id,@title,@agent,@status,@result,@createdAt,@updatedAt)").run(task); return send(res,201,{task}); } catch(e) { return send(res,500,{error:"Could not save the task."}); }
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/api/tasks/")) {
    try { const id=decodeURIComponent(url.pathname.slice("/api/tasks/".length)); const body=await readBody(req); const allowed=["Pending review","Approved · awaiting integration","Rejected"]; if(body.status!==undefined&&!allowed.includes(body.status))return send(res,400,{error:"Invalid task status."}); if(body.result!==undefined&&(typeof body.result!=="string"||body.result.length>12000))return send(res,400,{error:"Invalid task result."}); const task=db.prepare("SELECT * FROM tasks WHERE id = ?").get(id); if(!task)return send(res,404,{error:"Task not found."}); if(body.status!==undefined)task.status=body.status; if(body.result!==undefined)task.result=body.result; task.updatedAt=new Date().toISOString(); db.prepare("UPDATE tasks SET status=@status,result=@result,updatedAt=@updatedAt WHERE id=@id").run(task); return send(res,200,{task}); } catch(e) { return send(res,500,{error:"Could not update task."}); }
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    if (!process.env.OPENAI_API_KEY) {
      return send(res, 503, { error: "AI backend setup is incomplete. Add OPENAI_API_KEY to the hosting environment variables." });
    }

    try {
      const body = await readBody(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return send(res, 400, { error: "Please enter a message." });
      if (message.length > 8000) return send(res, 400, { error: "Message is too long. Please keep it under 8,000 characters." });

      const upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          instructions: SYSTEM_PROMPT,
          input: message,
          max_output_tokens: 900
        })
      });

      const result = await upstream.json();
      if (!upstream.ok) {
        const detail = result && result.error && result.error.message ? result.error.message : "The AI provider returned an error.";
        return send(res, upstream.status >= 500 ? 502 : 400, { error: detail });
      }

      const answer = (result.output || [])
        .flatMap(item => item.content || [])
        .filter(item => item.type === "output_text")
        .map(item => item.text)
        .join("\n")
        .trim();

      if (!answer) return send(res, 502, { error: "The AI response was empty. Please try again." });
      return send(res, 200, { answer, model: MODEL });
    } catch (error) {
      return send(res, 400, { error: error.message === "Request too large" ? error.message : "Could not process the request. Please try again." });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { error: "Method not allowed." });
  }

  if (url.pathname === "/sir-demo" && !requireAuth(req,res)) return;
  const requested = url.pathname === "/" ? "index.html" : (url.pathname === "/sir-demo" ? "sir-demo.html" : decodeURIComponent(url.pathname.slice(1)));
  const filePath = path.resolve(ROOT, requested);
  if (!filePath.startsWith(ROOT + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    return res.end("Not found");
  }

  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
  res.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Z 2 Digital workspace listening on port ${PORT}`);
});
