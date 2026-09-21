import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import admin from "firebase-admin";

const PORT = Number(process.env.PORT || 8790) || 8790;
const HOST = String(process.env.HOST || "0.0.0.0");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || "").trim();
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "").trim();
const FIREBASE_SERVICE_ACCOUNT_JSON = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Faltan SUPABASE_URL / SUPABASE_ANON_KEY en el entorno.");
  process.exit(1);
}
if (!FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("Falta FIREBASE_SERVICE_ACCOUNT_JSON en el entorno.");
  process.exit(1);
}

let serviceAccount;
try {
  // Acepta tanto el JSON crudo como base64 (util cuando el panel de hosting
  // no soporta bien saltos de linea/comillas en variables de entorno).
  const raw = FIREBASE_SERVICE_ACCOUNT_JSON.trim().startsWith("{")
    ? FIREBASE_SERVICE_ACCOUNT_JSON
    : Buffer.from(FIREBASE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8");
  serviceAccount = JSON.parse(raw);
} catch (e) {
  console.error("FIREBASE_SERVICE_ACCOUNT_JSON invalido:", e?.message);
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const norm = (v = "") =>
  String(v || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

async function tokensPorUserIds(userIds = []) {
  const ids = [...new Set((userIds || []).filter((x) => x !== null && x !== undefined))];
  if (!ids.length) return [];
  const { data, error } = await supabase.from("push_tokens").select("token,user_id").in("user_id", ids);
  if (error) {
    console.warn("Error leyendo push_tokens:", error.message);
    return [];
  }
  return (data || []).map((r) => r.token).filter(Boolean);
}

async function userIdsPorRol(rol) {
  const { data, error } = await supabase.from("usuarios").select("id,rol,activo").eq("activo", true);
  if (error) {
    console.warn("Error leyendo usuarios:", error.message);
    return [];
  }
  return (data || []).filter((u) => norm(u.rol) === norm(rol)).map((u) => u.id);
}

async function userIdPorNombre(nombre) {
  if (!nombre) return null;
  const target = norm(nombre);
  if (!target) return null;
  const { data, error } = await supabase.from("usuarios").select("id,nombre,username,activo").eq("activo", true);
  if (error) {
    console.warn("Error leyendo usuarios:", error.message);
    return null;
  }
  const match = (data || []).find((u) => {
    const n = norm(u.nombre);
    const un = norm(u.username);
    return n === target || un === target || (n && target.includes(n)) || (n && n.includes(target));
  });
  return match ? match.id : null;
}

async function enviarPush(tokens, { title, body, data = {} }) {
  const list = [...new Set((tokens || []).filter(Boolean))];
  if (!list.length) return { enviados: 0 };
  const dataStr = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")]));
  let enviados = 0;
  for (const token of list) {
    try {
      await admin.messaging().send({
        token,
        notification: { title, body },
        data: dataStr,
        android: { priority: "high", notification: { channelId: "default" } },
      });
      enviados += 1;
    } catch (e) {
      console.warn("Fallo enviando push a un token:", e?.errorInfo?.code || e?.message);
    }
  }
  return { enviados };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function checkSecret(req) {
  if (!WEBHOOK_SECRET) return true;
  const got = String(req.headers["x-webhook-secret"] || "").trim();
  return got === WEBHOOK_SECRET;
}

// ── Handlers de cada evento ──────────────────────────────────────────────

async function onOrdenInsert(record = {}) {
  const codigo = record.codigo || "";
  const cliente = record.nombre || record.cliente || "";
  const tecnico = record.tecnico || "";
  const nodo = record.nodo || "";

  const adminIds = await userIdsPorRol("Administrador");
  const adminTokens = await tokensPorUserIds(adminIds);
  await enviarPush(adminTokens, {
    title: "Nueva orden creada",
    body: `${codigo} — ${cliente}${nodo ? ` (${nodo})` : ""}`,
    data: { tipo: "nueva_orden", codigo },
  });

  if (tecnico) {
    const tecId = await userIdPorNombre(tecnico);
    const tecTokens = await tokensPorUserIds(tecId ? [tecId] : []);
    await enviarPush(tecTokens, {
      title: "Se te asignó una orden",
      body: `${codigo} — ${cliente}`,
      data: { tipo: "orden_asignada", codigo },
    });
  }
}

async function onLiquidacionInsert(record = {}) {
  const codigo = record.codigo || record.codigo_orden || "";
  const tecnicoLiquida = record.tecnico_liquida || record.tecnico || "";
  const estado = record.estado || "";

  const adminIds = await userIdsPorRol("Administrador");
  const adminTokens = await tokensPorUserIds(adminIds);
  await enviarPush(adminTokens, {
    title: "Orden liquidada",
    body: `${codigo} liquidada por ${tecnicoLiquida}${estado ? ` (${estado})` : ""}`,
    data: { tipo: "orden_liquidada", codigo },
  });

  if (codigo) {
    const { data: orden, error } = await supabase
      .from("ordenes")
      .select("autor_orden")
      .eq("codigo", codigo)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    const autor = !error ? orden?.autor_orden : null;
    if (autor) {
      const gestorId = await userIdPorNombre(autor);
      const gestorTokens = await tokensPorUserIds(gestorId ? [gestorId] : []);
      await enviarPush(gestorTokens, {
        title: "Tu orden fue liquidada",
        body: `${codigo} ya fue liquidada por ${tecnicoLiquida}`,
        data: { tipo: "orden_liquidada", codigo },
      });
    }
  }
}

async function onMaterialAsignado(record = {}, oldRecord = null) {
  const tecnico = record.tecnico || "";
  const materialNombre = record.material_nombre || "";
  const cantidad = Number(record.cantidad_asignada || 0);
  const cantidadAnterior = Number(oldRecord?.cantidad_asignada || 0);
  if (oldRecord && cantidad <= cantidadAnterior) return; // solo notificar si aumento

  if (!tecnico) return;
  const tecId = await userIdPorNombre(tecnico);
  const tecTokens = await tokensPorUserIds(tecId ? [tecId] : []);
  await enviarPush(tecTokens, {
    title: "Material asignado",
    body: `Se te asignó ${materialNombre}${cantidad ? ` (${cantidad})` : ""}`,
    data: { tipo: "material_asignado", material: materialNombre },
  });
}

// ── Servidor HTTP ─────────────────────────────────────────────────────────

const routes = {
  "/webhook/ordenes": async (payload) => {
    if (payload.type !== "INSERT") return;
    await onOrdenInsert(payload.record || {});
  },
  "/webhook/liquidaciones": async (payload) => {
    if (payload.type !== "INSERT") return;
    await onLiquidacionInsert(payload.record || {});
  },
  "/webhook/materiales": async (payload) => {
    if (payload.type !== "INSERT" && payload.type !== "UPDATE") return;
    await onMaterialAsignado(payload.record || {}, payload.type === "UPDATE" ? payload.old_record : null);
  },
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST" || !routes[req.url]) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (!checkSecret(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const payload = await readJsonBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    // Procesar despues de responder para que Supabase no espere el envio push.
    routes[req.url](payload).catch((e) => console.error(`Error procesando ${req.url}:`, e?.message));
  } catch (e) {
    console.error("Error en request:", e?.message);
    try {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    } catch (_) {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Servidor de notificaciones DIM escuchando en http://${HOST}:${PORT}`);
});
