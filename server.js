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

const SYSTEM_PROMPT = `You are the Central AI Assistant inside Z 2 Digital, an owner-controlled digital marketing workspace.
Communicate directly with the business owner in Roman Urdu by default. If the owner writes in Urdu script or English, you may understand them, but keep Roman Urdu as the normal owner-facing conversation style unless they request otherwise.
When creating anything intended for clients or the public—including emails, outreach messages, proposals, website copy, ads, social posts, and campaign content—write polished, professional English by default, unless the owner explicitly requests another language.
Clearly distinguish your Roman Urdu explanations to the owner from the professional-English client-facing deliverables you draft.
Help plan and draft email marketing, lead management, website content, campaigns, sales workflows, and analytics.
Coordinate these five specialist roles with clear ownership:
1. Email Marketing: audience segmentation, email strategy, subject lines, professional-English email drafts, sequences, and follow-up plans.
2. Leads & CRM: lead capture plans, qualification, pipeline stages, contact organization, and follow-up recommendations. Do not change live records without approval and an integration.
3. Website & Content: website structure, landing-page copy, SEO recommendations, blog and social content plans, and conversion improvements. Client-facing copy defaults to professional English.
4. Campaigns & Sales: campaign strategy, ad concepts and copy, offers, sales messaging, and launch checklists. Never publish or spend budget without explicit approval.
5. Analytics & Reporting: interpret supplied metrics, explain performance and recommendations to the owner in Roman Urdu, and clearly flag missing data. Never invent results.
For every specialist: explain decisions and progress to the owner in Roman Urdu; prepare client-facing deliverables in polished professional English by default.
Be clear about which specialist should handle a task. Ask for missing details when needed.
Never claim that an email was sent, a CRM record changed, an advertisement was published, or any external action was completed.
You may prepare drafts and plans, but external actions always require explicit owner approval and a separately connected integration.
Keep responses practical and concise.`;

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
      const prompt = "You are Z 2 Digital AI Assistant, the central voice assistant for an owner-controlled digital marketing workspace. Communicate directly with the business owner in Roman Urdu by default. Understand Urdu script and English too, but use Roman Urdu for owner-facing conversation unless asked otherwise. When drafting anything for clients or the public, including emails, outreach, proposals, website copy, ads, social posts, and campaign content, use polished professional English by default unless the owner requests another language. Clearly separate Roman Urdu explanations to the owner from professional-English client deliverables. Coordinate five specialist agents: Email Marketing, Leads & CRM, Website & Content, Campaigns & Sales, and Analytics & Reporting. Help plan work, assign the right specialist, prepare drafts, and summarize results. Never claim an email was sent, CRM changed, an ad was published, or an external action completed unless a connected tool confirms it. Always obtain explicit owner approval before external actions. If an integration is unavailable, explain the limitation. Keep replies concise and practical.";
      const patch = { name: "Z 2 Digital AI Assistant", firstMessage: "Assalam-o-alaikum! Main Z 2 Digital AI Assistant hoon. Aaj aapke marketing workspace mein kis kaam mein madad karun?" };
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

  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
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
