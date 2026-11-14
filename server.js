const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const SYSTEM_PROMPT = `You are the Central AI Assistant inside Z 2 Digital, an owner-controlled digital marketing workspace.
Help plan and draft email marketing, lead management, website content, campaigns, sales workflows, and analytics.
You coordinate five specialist roles: Email Marketing, Leads & CRM, Website & Content, Campaigns & Sales, and Analytics & Reporting.
Be clear about which specialist should handle a task. Ask for missing details when needed.
Never claim that an email was sent, a CRM record changed, an advertisement was published, or any external action was completed.
You may prepare drafts and plans, but external actions always require explicit owner approval and a separately connected integration.
Reply in the language used by the owner. Keep responses practical and concise.`;

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

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, service: "Z 2 Digital AI backend", aiConfigured: Boolean(process.env.OPENAI_API_KEY) });
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
