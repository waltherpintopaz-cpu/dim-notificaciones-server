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

// Preferencias por usuario (usuarios.notif_prefs, jsonb): { ordenes,
// liquidaciones, chat, tareas, materiales } -- false = ese usuario apago ese
// tipo de aviso (lo elige cada uno en "Mis notificaciones" del panel/app).
// Los urgentes (🚨) se mandan siempre. Si la columna no existe todavia, no se
// filtra nada.
async function filtrarPorPreferencia(ids, tipo) {
  if (!tipo || !ids.length) return ids;
  const { data, error } = await supabase.from("usuarios").select("id,notif_prefs").in("id", ids);
  if (error) return ids;
  const apagados = new Set((data || []).filter((u) => u?.notif_prefs && u.notif_prefs[tipo] === false).map((u) => u.id));
  return ids.filter((id) => !apagados.has(id));
}

async function tokensPorUserIds(userIds = [], tipo = null) {
  let ids = [...new Set((userIds || []).filter((x) => x !== null && x !== undefined))];
  if (!ids.length) return [];
  ids = await filtrarPorPreferencia(ids, tipo);
  if (!ids.length) return [];
  const { data, error } = await supabase.from("push_tokens").select("token,user_id").in("user_id", ids);
  if (error) {
    console.warn("Error leyendo push_tokens:", error.message);
    return [];
  }
  return (data || []).map((r) => r.token).filter(Boolean);
}

// Tokens que dibujan el chat en estilo conversacion (APK con ChatNotif.kt,
// registran token_type "fcm_conv"). A esos se les manda el chat como
// mensaje SOLO de datos; al resto, el aviso clasico de siempre.
async function tokensConversacion(tokens = []) {
  const lista = [...new Set((tokens || []).filter(Boolean))];
  if (!lista.length) return new Set();
  const { data, error } = await supabase.from("push_tokens").select("token").in("token", lista).eq("token_type", "fcm_conv");
  if (error) {
    console.warn("Error leyendo token_type:", error.message);
    return new Set();
  }
  return new Set((data || []).map((r) => r.token));
}

// Push de chat: estilo conversacion (una notificacion por chat, con
// Responder) a las APK nuevas; aviso clasico a las viejas.
async function enviarPushChat(tokens, { title, body, data = {}, android = null, conv }) {
  const lista = [...new Set((tokens || []).filter(Boolean))];
  if (!lista.length) return { enviados: 0 };
  const nuevos = await tokensConversacion(lista);
  const viejos = lista.filter((t) => !nuevos.has(t));
  let enviados = 0;
  if (viejos.length) enviados += (await enviarPush(viejos, { title, body, data, android })).enviados;
  if (!nuevos.size) return { enviados };
  const datos = Object.fromEntries(Object.entries({
    ...data,
    estilo: "conv",
    title,
    body,
    chat_key: conv.chatKey,
    chat_titulo: conv.titulo,
    autor: conv.autor,
    texto: conv.texto,
    msg_id: conv.msgId,
    ts: conv.ts,
    canal: android?.channelId || "chat_burbuja",
    icono: android?.icon || "",
    color: android?.color || "",
  }).map(([k, v]) => [k, String(v ?? "")]));
  for (const token of nuevos) {
    try {
      await admin.messaging().send({ token, data: datos, android: { priority: "high" } });
      enviados += 1;
    } catch (e) {
      console.warn("Fallo enviando push de chat (conv) a un token:", e?.errorInfo?.code || e?.message);
    }
  }
  return { enviados };
}

const tsMensaje = (record) => {
  const t = new Date(record?.created_at || Date.now()).getTime();
  return String(Number.isFinite(t) ? t : Date.now());
};

// rol puede ser un texto o una lista de roles.
async function userIdsPorRol(rol) {
  const { data, error } = await supabase.from("usuarios").select("id,rol,activo").eq("activo", true);
  if (error) {
    console.warn("Error leyendo usuarios:", error.message);
    return [];
  }
  const roles = new Set((Array.isArray(rol) ? rol : [rol]).map(norm));
  return (data || []).filter((u) => roles.has(norm(u.rol))).map((u) => u.id);
}

// Equipo del tecnico: el mismo y los usuarios activos con su mismo "grupo"
// (usuarios.grupo, ej. Luis + Cristian). Asi los avisos del chat de una
// orden les llegan a todos los que la ven en la app (pedido 2026-11-12).
async function userIdsEquipo(nombreTecnico) {
  const target = norm(nombreTecnico);
  if (!target) return [];
  let r = await supabase.from("usuarios").select("id,nombre,username,activo,grupo").eq("activo", true);
  if (r.error) r = await supabase.from("usuarios").select("id,nombre,username,activo").eq("activo", true);
  if (r.error) {
    console.warn("Error leyendo usuarios (equipo):", r.error.message);
    return [];
  }
  const lista = r.data || [];
  const tec = lista.find((u) => norm(u.nombre) === target || norm(u.username) === target)
    || lista.find((u) => { const n = norm(u.nombre); return n && (target.includes(n) || n.includes(target)); });
  if (!tec) return [];
  const grupo = String(tec.grupo || "").trim().toLowerCase();
  if (!grupo) return [tec.id];
  return lista.filter((u) => u.id === tec.id || String(u.grupo || "").trim().toLowerCase() === grupo).map((u) => u.id);
}

// Quienes reciben "todo lo que recibe el admin": admins y socios (perfil
// Socio de DIM, pedido 2026-11-10).
const ROLES_SUPERVISION = ["Administrador", "Socio"];

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

// ── Configuracion de notificaciones (web: Configuracion > Notificaciones) ──
// Tabla notificaciones_config (fila id=1) en el Supabase de DIM. Se cachea
// 30 s para no leerla en cada push. Iconos y sonidos deben existir en la APK
// (res/drawable/notif_chat_*.xml y canales chat_*); si un celular tiene una
// APK vieja sin ellos, Android usa el icono/canal por defecto (no se pierde).
const ICONOS_CHAT = ["globo", "campana", "sobre"];
const SONIDOS_CHAT = ["predeterminado", "burbuja", "doble", "campana"];
const colorValido = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c || "")) ? String(c) : null);
let cacheConfigNotif = { t: 0, v: null };
async function leerConfigNotif() {
  if (Date.now() - cacheConfigNotif.t < 30 * 1000) return cacheConfigNotif.v;
  const { data, error } = await supabase.from("notificaciones_config").select("*").eq("id", 1).maybeSingle();
  if (error) console.warn("Error leyendo notificaciones_config:", error.message);
  cacheConfigNotif = { t: Date.now(), v: error ? null : data || null };
  return cacheConfigNotif.v;
}
// Opciones para un aviso de CHAT; null = los avisos de chat estan apagados.
async function opcionesChat() {
  const cfg = (await leerConfigNotif()) || {};
  if (cfg.chat_activo === false) return null;
  const icono = ICONOS_CHAT.includes(cfg.chat_icono) ? cfg.chat_icono : "globo";
  const sonido = SONIDOS_CHAT.includes(cfg.chat_sonido) ? cfg.chat_sonido : "burbuja";
  const prefijo = cfg.chat_prefijo == null ? "💬" : String(cfg.chat_prefijo).trim();
  return {
    titulo: (t) => (prefijo ? `${prefijo} ${t}` : t),
    android: { channelId: `chat_${sonido}`, icon: `notif_chat_${icono}`, color: colorValido(cfg.chat_color) || "#7C3AED" },
  };
}

async function enviarPush(tokens, { title, body, data = {}, android = null }) {
  const list = [...new Set((tokens || []).filter(Boolean))];
  if (!list.length) return { enviados: 0 };
  const dataStr = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? "")]));
  // Avisos normales: canal "default" con el color configurado; los de chat
  // traen su propio canal/icono/color (opcionesChat).
  let androidNotif = android;
  if (!androidNotif) {
    const color = colorValido((await leerConfigNotif())?.normal_color);
    androidNotif = { channelId: "default", ...(color ? { color } : {}) };
  }
  let enviados = 0;
  for (const token of list) {
    try {
      await admin.messaging().send({
        token,
        notification: { title, body },
        data: dataStr,
        android: { priority: "high", notification: androidNotif },
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
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.warn("Error leyendo alertas_whatsapp_config:", error.message);
    return null;
  }
  return data || null;
}

// "Nod_01", "1", "nodo 1" -> "1"; si no tiene numero, el texto en minusculas.
function claveNodo(v) {
  const s = String(v ?? "").trim();
  const m = s.match(/\d+/);
  return m ? String(Number(m[0])) : s.toLowerCase();
}

// Nodos privados: si la orden es de un nodo con regla propia, la alerta va
// SOLO a los numeros de esa regla (y al grupo solo si la regla lo pide).
function reglaParaNodo(cfg, nodo) {
  if (!nodo && nodo !== 0) return null;
  const k = claveNodo(nodo);
  if (!k) return null;
  return (Array.isArray(cfg?.reglas_nodo) ? cfg.reglas_nodo : []).find((r) => r?.nodo && claveNodo(r.nodo) === k) || null;
}

// Numeros de 9 digitos (celular peruano) se completan con 51.
function destinosAlertas(cfg, nodo = null) {
  const regla = reglaParaNodo(cfg, nodo);
  const base = regla ? { grupo_id: regla.con_grupo ? cfg?.grupo_id : null, numeros: regla.numeros } : cfg;
  const out = [];
  if (base?.grupo_id) out.push(String(base.grupo_id).trim());
  for (const n of Array.isArray(base?.numeros) ? base.numeros : []) {
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

// Celular de un usuario (por nombre) en la base de la empresa -> "51XXXXXXXXX".
async function celularDeUsuario(sb, nombre) {
  const target = norm(nombre);
  if (!target) return null;
  const { data, error } = await sb.from("usuarios").select("nombre,username,celular,activo");
  if (error) {
    console.warn("Error leyendo celular de usuarios:", error.message);
    return null;
  }
  const u = (data || []).find((x) => x.activo !== false && (norm(x.nombre) === target || norm(x.username) === target))
    || (data || []).find((x) => x.activo !== false && norm(x.nombre) && (target.includes(norm(x.nombre)) || norm(x.nombre).includes(target)));
  const d = String(u?.celular || "").replace(/\D/g, "");
  if (d.length === 9) return `51${d}`;
  return d.length >= 10 ? d : null;
}

// Alerta 🚨 URGENTE por WhatsApp, en las dos direcciones y en los dos chats:
//   - escribe el TECNICO  -> grupo + numeros de la oficina (alertas_whatsapp_config,
//                            con reglas de nodo privado si es chat de orden)
//   - escribe la OFICINA  -> celular del tecnico (usuarios.celular), si
//                            aviso_tecnico_whatsapp no esta apagado
// ctx: { orden } para el chat de la orden, { hiloTecnico } para el chat con oficina.
const ultimaUrgente = new Map();
const urgentesProcesados = new Set();
async function onChatUrgente(record = {}, ctx = {}, empresa = "dim") {
  const emp = EMPRESAS[empresa] || EMPRESAS.dim;
  const orden = ctx.orden || {};
  const hilo = ctx.hiloTecnico || "";
  // Un mismo mensaje puede llegar por dos caminos (trigger viejo + nuevo).
  const idMsg = `${empresa}:${hilo ? "hilo" : "orden"}:${record.id}`;
  if (record.id != null) {
    if (urgentesProcesados.has(idMsg)) return;
    urgentesProcesados.add(idMsg);
    if (urgentesProcesados.size > 5000) urgentesProcesados.clear();
  }
  const cfg = await leerConfigAlertas(emp.sb);
  if (!cfg?.activo) return;
  const esTec = norm(record.autor_rol) === "tecnico";

  let destinos = [];
  if (esTec) {
    destinos = destinosAlertas(cfg, hilo ? null : orden.nodo);
  } else {
    if (cfg.aviso_tecnico_whatsapp === false) return;
    const tecnico = hilo || orden.tecnico || "";
    if (!tecnico || norm(tecnico) === norm(record.autor)) return;
    const cel = await celularDeUsuario(emp.sb, tecnico);
    if (!cel) {
      console.warn(`Urgente para ${tecnico} (${emp.nombre}): no tiene celular registrado.`);
      return;
    }
    destinos = [cel];
  }
  if (!destinos.length) return;

  // Freno del lado del servidor (la app ya limita a 1 cada 10 min).
  const ahora = Date.now();
  const clave = `${empresa}:${hilo ? `hilo:${norm(hilo)}` : `orden:${record.orden_id}`}:${esTec ? "tec" : "ofi"}:${norm(record.autor)}`;
  if (ahora - (ultimaUrgente.get(clave) || 0) < 2 * 60 * 1000) return;
  ultimaUrgente.set(clave, ahora);

  const hora = new Date(record.created_at || ahora).toLocaleTimeString("es-PE", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/Lima",
  });
  const titulo = hilo
    ? `🚨 *URGENTE ${emp.nombre} · Chat con oficina*`
    : `🚨 *URGENTE ${emp.nombre} · ${orden.codigo || `Orden ${record.orden_id}`}*`;
  const lineas = [
    titulo,
    "",
    `${esTec ? "👷" : "🏢"} ${record.autor}${record.autor_rol ? ` (${record.autor_rol})` : ""}`,
    !hilo && orden.nombre ? `👤 Cliente: ${orden.nombre}${orden.nodo ? ` · ${orden.nodo}` : ""}` : null,
    !hilo && !esTec && orden.direccion ? `📍 ${orden.direccion}` : null,
    "",
    record.texto ? `💬 "${record.texto}"` : null,
    record.foto_url ? `📷 ${record.foto_url}` : null,
    "",
    esTec
      ? `🕒 ${hora} · Responder en el chat ${hilo ? `con ${record.autor}` : "de la orden"} (app o web)`
      : `🕒 ${hora} · Responde en la app, en el chat ${hilo ? "con oficina" : "de la orden"}`,
  ].filter((x) => x !== null);
  await enviarWhatsapp(destinos, lineas.join("\n"));
}

// Push "fuerte" para los urgentes: canal "urgente" de la APK (importancia
// maxima, sonido de alarma, vibracion larga). Se apaga con
// alertas_whatsapp_config.push_fuerte = false (vuelve al canal del chat).
const ANDROID_URGENTE = { channelId: "urgente", icon: "notif_chat_campana", color: "#DC2626" };
async function androidParaMensaje(record, opc) {
  if (!record.urgente) return opc?.android || null;
  const cfg = await leerConfigAlertas(supabase);
  if (cfg && cfg.push_fuerte === false) return opc?.android || null;
  return ANDROID_URGENTE;
}

// Americanet: avisos que llegan SIN secreto (su trigger nuevo no lo tiene).
// No se confia en el payload: se relee el mensaje en la base de Americanet y
// solo se actua si existe, es urgente, es reciente y no se proceso antes --
// asi nadie puede usar esta ruta para mandar WhatsApp con texto inventado.
async function urgenteAmericanetVerificado(tabla, id) {
  if (id == null) return null;
  const { data: msg, error } = await sbAmericanet.from(tabla).select("*").eq("id", id).maybeSingle();
  if (error || !msg || !msg.urgente) return null;
  if (Date.now() - new Date(msg.created_at || 0).getTime() > 10 * 60 * 1000) return null;
  return msg;
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

  const adminIds = await userIdsPorRol(ROLES_SUPERVISION);
  const adminTokens = await tokensPorUserIds(adminIds, "ordenes");
  await enviarPush(adminTokens, {
    title: "Nueva orden creada",
    body: `${codigo} — ${cliente}${nodo ? ` (${nodo})` : ""}`,
    data: { tipo: "nueva_orden", codigo },
  });

  if (tecnico) {
    const tecId = await userIdPorNombre(tecnico);
    const tecTokens = await tokensPorUserIds(tecId ? [tecId] : [], "ordenes");
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

  const adminIds = await userIdsPorRol(ROLES_SUPERVISION);
  const adminTokens = await tokensPorUserIds(adminIds, "liquidaciones");
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
      const gestorTokens = await tokensPorUserIds(gestorId ? [gestorId] : [], "liquidaciones");
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
    onChatUrgente(record, { orden }).catch((e) => console.error("Error alerta urgente:", e?.message));
  }

  // Los urgentes se avisan aunque los avisos de chat esten apagados.
  const opc = (await opcionesChat()) || (record.urgente ? { titulo: (t) => t, android: null } : null);
  if (!opc) return;
  const android = await androidParaMensaje(record, opc);
  const titulo = record.urgente
    ? `🚨 URGENTE · Orden${orden.codigo ? ` ${orden.codigo}` : ""}`
    : opc.titulo(`Orden${orden.codigo ? ` ${orden.codigo}` : ""}`);
  const cuerpo = `${autor}: ${texto}`;
  const dataPayload = { tipo: "chat_orden", orden_id: String(ordenId), urgente: record.urgente ? "1" : "" };
  const conv = {
    chatKey: `orden:${ordenId}`,
    titulo: [orden.codigo || "Orden", orden.nombre].filter(Boolean).join(" · "),
    autor,
    texto: record.texto || (record.foto_url ? "📷 Foto" : ""),
    msgId: record.id,
    ts: tsMensaje(record),
  };

  // A quien avisar: admins/socios + el equipo del tecnico asignado (el y
  // los de su mismo grupo), menos el propio autor. Si escribe un tecnico
  // del equipo, se enteran sus compañeros; si escribe la oficina, todo el
  // equipo.
  const autorId = await userIdPorNombre(autor);
  const destinatarioIds = new Set();
  if (orden.tecnico) {
    for (const id of await userIdsEquipo(orden.tecnico)) destinatarioIds.add(id);
  }
  for (const id of await userIdsPorRol(ROLES_SUPERVISION)) destinatarioIds.add(id);
  // @menciones: el mencionado recibe aviso aparte, mas fuerte (como urgente),
  // aunque no sea del equipo de la orden.
  const mencionadoIds = new Set();
  for (const n of Array.isArray(record.menciones) ? record.menciones : []) {
    const id = await userIdPorNombre(n);
    if (id && id !== autorId) { mencionadoIds.add(id); destinatarioIds.delete(id); }
  }
  if (autorId) destinatarioIds.delete(autorId);
  const tokens = await tokensPorUserIds([...destinatarioIds], record.urgente ? null : "chat");
  await enviarPushChat(tokens, { title: titulo, body: cuerpo, data: dataPayload, android, conv });
  if (mencionadoIds.size) {
    const tokMen = await tokensPorUserIds([...mencionadoIds], null);
    const androidMen = await androidParaMensaje({ ...record, urgente: true }, opc);
    const quien = String(autor).trim().split(" ")[0] || "Alguien";
    await enviarPushChat(tokMen, { title: `📣 ${quien} te mencionó · ${orden.codigo || "Orden"}`, body: cuerpo, data: dataPayload, android: androidMen, conv });
  }
}

async function onChatTecnicoMensaje(record = {}) {
  const tecnicoNombre = record.tecnico_nombre || "";
  const autor = record.autor || "";
  const autorRol = norm(record.autor_rol || "");
  const texto = record.texto || (record.foto_url ? "Foto" : "");
  if (!tecnicoNombre || !autor) return;

  if (record.urgente) {
    onChatUrgente(record, { hiloTecnico: tecnicoNombre }).catch((e) => console.error("Error alerta urgente (hilo):", e?.message));
  }

  const opc = (await opcionesChat()) || (record.urgente ? { titulo: (t) => t, android: null } : null);
  if (!opc) return;
  const android = await androidParaMensaje(record, opc);
  const titulo = record.urgente ? `🚨 URGENTE · ${autor}` : opc.titulo(autor);
  const cuerpo = texto;
  const dataPayload = { tipo: "chat_tecnico", tecnico_nombre: tecnicoNombre, urgente: record.urgente ? "1" : "" };
  const convBase = {
    chatKey: `tecnico:${String(tecnicoNombre).trim()}`,
    autor,
    texto: record.texto || (record.foto_url ? "📷 Foto" : ""),
    msgId: record.id,
    ts: tsMensaje(record),
  };

  if (autorRol === norm("Tecnico")) {
    // Tecnico escribio -> avisar a todas las gestoras + admins.
    const gestoraIds = await userIdsPorRol("Gestora");
    const adminIds = await userIdsPorRol(ROLES_SUPERVISION);
    const tokens = await tokensPorUserIds([...gestoraIds, ...adminIds], record.urgente ? null : "chat");
    await enviarPushChat(tokens, { title: titulo, body: cuerpo, data: dataPayload, android, conv: { ...convBase, titulo: `👷 ${tecnicoNombre}` } });
  } else {
    // Gestora o admin escribio -> avisar solo al tecnico del hilo.
    const tecId = await userIdPorNombre(tecnicoNombre);
    const tecTokens = await tokensPorUserIds(tecId ? [tecId] : [], record.urgente ? null : "chat");
    await enviarPushChat(tecTokens, { title: titulo, body: cuerpo, data: dataPayload, android, conv: { ...convBase, titulo: "🏢 Oficina" } });
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
  const tecTokens = await tokensPorUserIds(tecId ? [tecId] : [], "materiales");
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
  const tokens = await tokensPorUserIds(tecId ? [tecId] : [], "tareas");
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
    await onChatUrgente(record, { orden: orden || {} }, "americanet");
  },
};

// Americanet, rutas SIN secreto (ver urgenteAmericanetVerificado): el trigger
// solo manda { id } del mensaje urgente y aqui se relee de la base.
const rutasAvisoAmericanet = {
  "/aviso/chat-ordenes-americanet": async ({ id }) => {
    const msg = await urgenteAmericanetVerificado("chat_ordenes_mensajes", id);
    if (!msg?.orden_id) return;
    const { data: orden } = await sbAmericanet.from("ordenes").select("*").eq("id", msg.orden_id).maybeSingle();
    await onChatUrgente(msg, { orden: orden || {} }, "americanet");
  },
  "/aviso/chat-tecnicos-americanet": async ({ id }) => {
    const msg = await urgenteAmericanetVerificado("chat_tecnicos_mensajes", id);
    if (!msg?.tecnico_nombre) return;
    await onChatUrgente(msg, { hiloTecnico: msg.tecnico_nombre }, "americanet");
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
      const nodo = u.searchParams.get("nodo");
      if (nodo && !reglaParaNodo(cfg, nodo)) return responder(200, { ok: false, error: "Ese nodo no tiene regla guardada." });
      const destinos = destinosAlertas(cfg, nodo);
      if (!destinos.length) return responder(200, { ok: false, error: "No hay grupo ni números guardados." });
      const r = await enviarWhatsapp(destinos, `✅ *Prueba de alertas ${EMPRESAS[empresa].nombre}${nodo ? ` · nodo ${nodo}` : ""}*\n\nAsí llegarán los mensajes 🚨 URGENTE que manden los técnicos desde el chat de la orden.`);
      return responder(200, { ok: r.enviados > 0, enviados: r.enviados, total: destinos.length, errores: r.errores });
    }
    // Prueba al celular de UN tecnico (el guardado en usuarios.celular).
    if (req.method === "POST" && ruta === "/alertas/prueba-tecnico") {
      const nombre = String(u.searchParams.get("nombre") || "").trim();
      if (!nombre) return responder(200, { ok: false, error: "Falta el técnico." });
      const k = `${empresa}:tec:${norm(nombre)}`;
      if (Date.now() - (ultimaPrueba[k] || 0) < 30 * 1000) return responder(200, { ok: false, error: "Espera 30 segundos entre pruebas." });
      ultimaPrueba[k] = Date.now();
      const cel = await celularDeUsuario(EMPRESAS[empresa].sb, nombre);
      if (!cel) return responder(200, { ok: false, error: `${nombre} no tiene celular guardado.` });
      const r = await enviarWhatsapp([cel], `✅ *Prueba de alertas ${EMPRESAS[empresa].nombre}*\n\nHola ${nombre}, así te llegarán los mensajes 🚨 URGENTE que te mande la oficina desde el chat. Responde siempre desde la app.`);
      return responder(200, { ok: r.enviados > 0, enviados: r.enviados, total: 1, errores: r.errores });
    }
    return responder(404, { ok: false, error: "not found" });
  } catch (e) {
    return responder(200, { ok: false, error: e?.message || "Error" });
  }
}

// Prueba desde la web (Configuracion > Notificaciones): manda un aviso de
// chat de ejemplo, con la configuracion guardada, al usuario que la pide.
// Solo DIM (Americanet manda sus avisos por su propia Edge Function).
const ultimaPruebaNotif = {};
async function rutaNotificaciones(req, res) {
  const u = new URL(req.url, "http://local");
  const responder = (status, obj) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "OPTIONS") return responder(204, {});
  try {
    if (req.method === "POST" && u.pathname === "/notificaciones/prueba") {
      const { usuario } = await readJsonBody(req);
      const nombre = String(usuario || "").trim();
      if (!nombre) return responder(200, { ok: false, error: "Falta el usuario." });
      if (Date.now() - (ultimaPruebaNotif[norm(nombre)] || 0) < 20 * 1000) return responder(200, { ok: false, error: "Espera 20 segundos entre pruebas." });
      ultimaPruebaNotif[norm(nombre)] = Date.now();
      cacheConfigNotif = { t: 0, v: null }; // leer lo recien guardado
      const opc = await opcionesChat();
      if (!opc) return responder(200, { ok: false, error: "Los avisos de chat están apagados." });
      const id = await userIdPorNombre(nombre);
      const tokens = await tokensPorUserIds(id ? [id] : []);
      if (!tokens.length) return responder(200, { ok: false, error: "Tu usuario no tiene un celular registrado. Inicia sesión en la app y vuelve a probar." });
      const r = await enviarPush(tokens, { title: opc.titulo("Prueba de chat"), body: "Así se verán los mensajes del chat.", data: { tipo: "prueba" }, android: opc.android });
      return responder(200, { ok: r.enviados > 0, enviados: r.enviados });
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
    if (String(req.url || "").startsWith("/notificaciones/")) {
      await rutaNotificaciones(req, res);
      return;
    }
    if (String(req.url || "").startsWith("/alertas/")) {
      await rutaAlertas(req, res);
      return;
    }
    if (req.method === "POST" && rutasAvisoAmericanet[req.url]) {
      const body = await readJsonBody(req).catch(() => ({}));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      rutasAvisoAmericanet[req.url](body || {}).catch((e) => console.error(`Error procesando ${req.url}:`, e?.message));
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
