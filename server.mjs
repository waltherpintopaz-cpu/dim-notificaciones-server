import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import admin from "firebase-admin";
import ws from "ws";

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
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { transport: ws },
});

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

// ── Alertas urgentes por WhatsApp (Evolution API) ────────────────────────
// Solo los mensajes del chat de la orden marcados como URGENTE (boton 🚨 del
// tecnico) mandan WhatsApp. A quien: grupo + numeros guardados en la tabla
// alertas_whatsapp_config (id=1), que se edita desde la web (Configuracion
// > Alertas WhatsApp). La API key de Evolution vive solo aqui (env), nunca
// en la app ni en la web.
const EVOLUTION_URL = String(process.env.EVOLUTION_URL || "https://api.americanet.space").trim().replace(/\/+$/, "");
const EVOLUTION_INSTANCIA = String(process.env.EVOLUTION_INSTANCIA || "Notificaciones DIM").trim();
const EVOLUTION_APIKEY = String(process.env.EVOLUTION_APIKEY || "").trim();

function urlEvolution(ruta, query = "") {
  return `${EVOLUTION_URL}${ruta}/${encodeURIComponent(EVOLUTION_INSTANCIA)}${query}`;
}

// Americanet usa el mismo mecanismo de alertas (misma linea de WhatsApp),
// pero con su propio Supabase: su config vive en SU alertas_whatsapp_config
// y su trigger llama a /webhook/chat-ordenes-americanet solo con los
// mensajes urgentes. La anon key es publica (va igual en la web).
const AMERICANET_SUPABASE_URL = String(process.env.AMERICANET_SUPABASE_URL || "https://vgwbqbzpjlbkmxtfghdm.supabase.co").trim();
const AMERICANET_SUPABASE_ANON_KEY = String(process.env.AMERICANET_SUPABASE_ANON_KEY || "sb_publishable_sC_66p4UKHUudDVyWyNcyA_bkrl_J2_").trim();
const sbAmericanet = createClient(AMERICANET_SUPABASE_URL, AMERICANET_SUPABASE_ANON_KEY, { realtime: { transport: ws } });
const EMPRESAS = {
  dim: { sb: supabase, nombre: "DIM" },
  americanet: { sb: sbAmericanet, nombre: "Americanet" },
};
const empresaDe = (clave) => EMPRESAS[String(clave || "").toLowerCase()] ? String(clave).toLowerCase() : "dim";

async function leerConfigAlertas(sb = supabase) {
  const { data, error } = await sb
    .from("alertas_whatsapp_config")
    .select("activo,grupo_id,grupo_nombre,numeros")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.warn("Error leyendo alertas_whatsapp_config:", error.message);
    return null;
  }
  return data || null;
}

// Numeros de 9 digitos (celular peruano) se completan con 51.
function destinosAlertas(cfg) {
  const out = [];
  if (cfg?.grupo_id) out.push(String(cfg.grupo_id).trim());
  for (const n of Array.isArray(cfg?.numeros) ? cfg.numeros : []) {
    const d = String(n?.numero ?? n ?? "").replace(/\D/g, "");
    if (d.length === 9) out.push(`51${d}`);
    else if (d.length >= 10) out.push(d);
  }
  return [...new Set(out.filter(Boolean))];
}

async function enviarWhatsapp(destinos, texto) {
  if (!EVOLUTION_APIKEY) return { enviados: 0, errores: ["Falta EVOLUTION_APIKEY en el servidor"] };
  let enviados = 0;
  const errores = [];
  for (const number of destinos) {
    try {
      const res = await fetch(urlEvolution("/message/sendText"), {
        method: "POST",
        headers: { apikey: EVOLUTION_APIKEY, "Content-Type": "application/json" },
        body: JSON.stringify({ number, text: texto }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      enviados += 1;
    } catch (e) {
      errores.push(`${number}: ${e?.message}`);
    }
    // Pausa corta entre envios para no parecer spam ante WhatsApp.
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (errores.length) console.warn("Errores enviando WhatsApp:", errores.join(" | "));
  return { enviados, errores };
}

const ultimaUrgentePorOrden = new Map();
async function onChatUrgente(record = {}, orden = {}, empresa = "dim") {
  const emp = EMPRESAS[empresa] || EMPRESAS.dim;
  const cfg = await leerConfigAlertas(emp.sb);
  if (!cfg?.activo) return;
  const destinos = destinosAlertas(cfg);
  if (!destinos.length) return;
  // Freno del lado del servidor (la app ya limita a 1 cada 10 min por orden).
  const ahora = Date.now();
  const clave = `${empresa}:${record.orden_id}`;
  if (ahora - (ultimaUrgentePorOrden.get(clave) || 0) < 2 * 60 * 1000) return;
  ultimaUrgentePorOrden.set(clave, ahora);

  const hora = new Date(record.created_at || ahora).toLocaleTimeString("es-PE", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/Lima",
  });
  const lineas = [
    `🚨 *URGENTE ${emp.nombre} · ${orden.codigo || `Orden ${record.orden_id}`}*`,
    "",
    `👷 ${record.autor}${record.autor_rol ? ` (${record.autor_rol})` : ""}`,
    orden.nombre ? `👤 Cliente: ${orden.nombre}${orden.nodo ? ` · ${orden.nodo}` : ""}` : null,
    "",
    record.texto ? `💬 "${record.texto}"` : null,
    record.foto_url ? `📷 ${record.foto_url}` : null,
    "",
    `🕒 ${hora} · Responder en el chat de la orden (app o web)`,
  ].filter((x) => x !== null);
  await enviarWhatsapp(destinos, lineas.join("\n"));
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

async function onChatOrdenMensaje(record = {}) {
  const ordenId = record.orden_id;
  const autor = record.autor || "";
  const autorRol = norm(record.autor_rol || "");
  const texto = record.texto || (record.foto_url ? "Foto" : "");
  if (!ordenId || !autor) return;

  const { data: orden, error } = await supabase
    .from("ordenes")
    .select("*")
    .eq("id", ordenId)
    .maybeSingle();
  if (error || !orden) return;

  if (record.urgente) {
    onChatUrgente(record, orden).catch((e) => console.error("Error alerta urgente:", e?.message));
  }

  const titulo = `${record.urgente ? "🚨 URGENTE · " : ""}Mensaje en orden${orden.codigo ? ` ${orden.codigo}` : ""}`;
  const cuerpo = `${autor}: ${texto}`;
  const dataPayload = { tipo: "chat_orden", orden_id: String(ordenId) };

  if (autorRol === norm("Tecnico")) {
    // Tecnico escribio -> avisar a todos los admins activos.
    const adminIds = await userIdsPorRol("Administrador");
    const adminTokens = await tokensPorUserIds(adminIds);
    await enviarPush(adminTokens, { title: titulo, body: cuerpo, data: dataPayload });
  } else {
    // Gestora o admin escribio -> avisar al tecnico asignado a esa orden,
    // y ademas a todos los admins (pedido explicito: si escribe una
    // gestora, el admin tambien se entera). No se duplica aviso al propio
    // autor si el que escribe es admin.
    const destinatarioIds = new Set();
    if (orden.tecnico && norm(orden.tecnico) !== norm(autor)) {
      const tecId = await userIdPorNombre(orden.tecnico);
      if (tecId) destinatarioIds.add(tecId);
    }
    const adminIds = await userIdsPorRol("Administrador");
    const autorId = await userIdPorNombre(autor);
    for (const id of adminIds) {
      if (id !== autorId) destinatarioIds.add(id);
    }
    const tokens = await tokensPorUserIds([...destinatarioIds]);
    await enviarPush(tokens, { title: titulo, body: cuerpo, data: dataPayload });
  }
}

async function onChatTecnicoMensaje(record = {}) {
  const tecnicoNombre = record.tecnico_nombre || "";
  const autor = record.autor || "";
  const autorRol = norm(record.autor_rol || "");
  const texto = record.texto || (record.foto_url ? "Foto" : "");
  if (!tecnicoNombre || !autor) return;

  const titulo = `Mensaje de ${autor}`;
  const cuerpo = texto;
  const dataPayload = { tipo: "chat_tecnico", tecnico_nombre: tecnicoNombre };

  if (autorRol === norm("Tecnico")) {
    // Tecnico escribio -> avisar a todas las gestoras + admins.
    const gestoraIds = await userIdsPorRol("Gestora");
    const adminIds = await userIdsPorRol("Administrador");
    const tokens = await tokensPorUserIds([...gestoraIds, ...adminIds]);
    await enviarPush(tokens, { title: titulo, body: cuerpo, data: dataPayload });
  } else {
    // Gestora o admin escribio -> avisar solo al tecnico del hilo.
    const tecId = await userIdPorNombre(tecnicoNombre);
    const tecTokens = await tokensPorUserIds(tecId ? [tecId] : []);
    await enviarPush(tecTokens, { title: titulo, body: cuerpo, data: dataPayload });
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

async function onTareaInsert(record = {}) {
  // Solo urgentes -- las normales no justifican interrumpir con push (se ven
  // igual en "Mis tareas" de la app/panel). Pedido explicito 2026-11-03:
  // "en la apk tambien quiero esto" (push cuando me asignan una urgente).
  if (record.prioridad !== "alta") return;
  const asignadoA = record.asignado_a || "";
  if (!asignadoA) return;

  const tecId = await userIdPorNombre(asignadoA);
  const tokens = await tokensPorUserIds(tecId ? [tecId] : []);
  await enviarPush(tokens, {
    title: `🔴 Tarea urgente${record.cliente_nombre ? ` · ${record.cliente_nombre}` : ""}`,
    body: `${record.asignado_por || "Alguien"}: ${record.descripcion || ""}`,
    data: { tipo: "tarea_urgente", tarea_id: String(record.id || "") },
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
  "/webhook/chat-ordenes": async (payload) => {
    if (payload.type !== "INSERT") return;
    await onChatOrdenMensaje(payload.record || {});
  },
  "/webhook/chat-tecnicos": async (payload) => {
    if (payload.type !== "INSERT") return;
    await onChatTecnicoMensaje(payload.record || {});
  },
  "/webhook/tareas": async (payload) => {
    if (payload.type !== "INSERT") return;
    await onTareaInsert(payload.record || {});
  },
  // Americanet: su trigger solo manda los mensajes urgentes del chat (el
  // push de Americanet va por otro lado); aqui solo se manda el WhatsApp.
  "/webhook/chat-ordenes-americanet": async (payload) => {
    const record = payload.record || {};
    if (payload.type !== "INSERT" || !record.urgente || !record.orden_id) return;
    const { data: orden } = await sbAmericanet.from("ordenes").select("*").eq("id", record.orden_id).maybeSingle();
    await onChatUrgente(record, orden || {}, "americanet");
  },
};

// Endpoints para la pantalla "Alertas WhatsApp" de la web: estado de la
// linea, lista de grupos (para elegir uno) y mensaje de prueba. No exponen
// la API key; la prueba solo puede ir a los destinos ya guardados.
const ultimaPrueba = {};
async function rutaAlertas(req, res) {
  const u = new URL(req.url, "http://local");
  const ruta = u.pathname;
  const empresa = empresaDe(u.searchParams.get("empresa"));
  const responder = (status, obj) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "OPTIONS") return responder(204, {});
  try {
    if (req.method === "GET" && ruta === "/alertas/estado") {
      if (!EVOLUTION_APIKEY) return responder(200, { ok: false, error: "Falta EVOLUTION_APIKEY en el servidor" });
      const r = await fetch(urlEvolution("/instance/connectionState"), { headers: { apikey: EVOLUTION_APIKEY } });
      const j = await r.json().catch(() => ({}));
      return responder(200, { ok: r.ok, instancia: EVOLUTION_INSTANCIA, estado: j?.instance?.state || j?.state || "desconocido" });
    }
    if (req.method === "GET" && ruta === "/alertas/grupos") {
      if (!EVOLUTION_APIKEY) return responder(200, { ok: false, error: "Falta EVOLUTION_APIKEY en el servidor" });
      const r = await fetch(urlEvolution("/group/fetchAllGroups", "?getParticipants=false"), { headers: { apikey: EVOLUTION_APIKEY } });
      const j = await r.json().catch(() => []);
      if (!r.ok) return responder(200, { ok: false, error: `Evolution respondio ${r.status}` });
      const grupos = (Array.isArray(j) ? j : [])
        .map((g) => ({ id: g.id, nombre: String(g.subject || "").trim() || g.id, miembros: g.size || null }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
      return responder(200, { ok: true, grupos });
    }
    if (req.method === "POST" && ruta === "/alertas/prueba") {
      if (Date.now() - (ultimaPrueba[empresa] || 0) < 30 * 1000) return responder(200, { ok: false, error: "Espera 30 segundos entre pruebas." });
      ultimaPrueba[empresa] = Date.now();
      const cfg = await leerConfigAlertas(EMPRESAS[empresa].sb);
      const destinos = destinosAlertas(cfg);
      if (!destinos.length) return responder(200, { ok: false, error: "No hay grupo ni números guardados." });
      const r = await enviarWhatsapp(destinos, `✅ *Prueba de alertas ${EMPRESAS[empresa].nombre}*\n\nAsí llegarán los mensajes 🚨 URGENTE que manden los técnicos desde el chat de la orden.`);
      return responder(200, { ok: r.enviados > 0, enviados: r.enviados, total: destinos.length, errores: r.errores });
    }
    return responder(404, { ok: false, error: "not found" });
  } catch (e) {
    return responder(200, { ok: false, error: e?.message || "Error" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (String(req.url || "").startsWith("/alertas/")) {
      await rutaAlertas(req, res);
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
