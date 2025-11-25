import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { GoogleGenerativeAI } from "@google/generative-ai";
// @ts-ignore
import input = require("input");
import * as dotenv from "dotenv";

// IMPORTS ESTRICTOS SOLICITADOS
import { resolverFechaRelativa, normalizarHora } from "./utils/utils_modified";
import { obtenerHistorialCompleto, guardarEnGoogleSheets } from "./utils/sheets_modified";

dotenv.config();

// --- CONFIGURACIÓN ---
const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || "";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");
const targetChatId = process.env.TARGET_CHAT_ID ? BigInt(process.env.TARGET_CHAT_ID.replace(/['"]+/g, '')) : BigInt(0);
const geminiApiKey = process.env.GEMINI_API_KEY || "";

// --- UTILIDAD PARA PAUSAR ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- LÓGICA DE FECHA HÍBRIDA ---
let targetDate: Date;
const argMes = process.argv[2];
const argAnio = process.argv[3];

if (argMes && argAnio) {
    console.log(`💻 MODO MANUAL (Local): Recibido Mes ${argMes}, Año ${argAnio}`);
    targetDate = new Date(Number(argAnio), Number(argMes) - 1, 1);
} else if (process.env.MANUAL_MONTH && process.env.MANUAL_YEAR) {
    console.log(`☁️ MODO MANUAL (GitHub): Recibido Mes ${process.env.MANUAL_MONTH}, Año ${process.env.MANUAL_YEAR}`);
    targetDate = new Date(Number(process.env.MANUAL_YEAR), Number(process.env.MANUAL_MONTH) - 1, 1);
} else {
    console.log("🤖 MODO AUTOMÁTICO (Batch): Calculando mes anterior...");
    const today = new Date();
    targetDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
}

const TARGET_MONTH = targetDate.getMonth();
const TARGET_YEAR = targetDate.getFullYear();

console.log(`📅 PERIODO A ANALIZAR: MES ${TARGET_MONTH + 1} / AÑO ${TARGET_YEAR}`);

// --- FUNCIÓN GEMINI (SOPORTA LISTAS) ---
async function analizarVoucherConGemini(imageBuffer: Buffer): Promise<any[] | null> {
    if (!geminiApiKey) return null;

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    // Usamos gemini-2.5-flash
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `
        Actúa como un OCR financiero experto. Analiza la imagen.
        
        CASO 1: Si es un VOUCHER individual, extrae un solo objeto.
        CASO 2: Si es una LISTA DE MOVIMIENTOS (Estado de cuenta/App), extrae TODOS los movimientos.

        Devuelve SIEMPRE un ARRAY de objetos JSON. Estructura:
        {
            "tipo_imagen": (string. "LISTA" o "INDIVIDUAL"),
            "monto": (número decimal. IMPORTANTE: Extrae el valor absoluto, sin signo negativo),
            "es_negativo_originalmente": (boolean. true si tiene signo menos "-", false si es positivo/abono),
            "moneda": (string, 'PEN' o 'USD' o 'S/'),
            "fecha": (string, formato YYYY-MM-DD. Si la lista tiene fechas cortas como "17 Nov", NO inventes el año, devuelve "17/11". Si dice "ayer"/"hoy", escribe literal), 
            "hora": (string. IMPORTANTE: Si tiene AM/PM inclúyelo. Ej: "3:13 pm". Si no hay, null), 
            "destinatario": (string. Nombre del comercio o descripción),
            "app_origen": (string. JERARQUÍA: 1.Plin, 2.Yape, 3.CMR, 4.Interbank, 5.Banco),
            "codigo_operacion": (string o null),
            "mensaje_en_voucher": (string o null. REGLA: SOLO si es "Yape" extrae texto, sino null)
        }
    `;

    let intentos = 0;
    const MAX_INTENTOS = 3;

    while (intentos < MAX_INTENTOS) {
        try {
            const result = await model.generateContent([
                prompt,
                { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } }
            ]);
            const text = result.response.text();
            const jsonString = text.replace(/```json|```/g, "").trim();

            const parsed = JSON.parse(jsonString);
            return Array.isArray(parsed) ? parsed : [parsed];

        } catch (error: any) {
            intentos++;
            const errMsg = error.toString();
            const esErrorRecuperable = errMsg.includes("429") || errMsg.includes("500") || errMsg.includes("503") || error.status === 429;

            if (esErrorRecuperable && intentos < MAX_INTENTOS) {
                const tiempoEspera = 30000 * intentos;
                console.warn(`   ⚠️ Error API (${error.status || 'Cuota'}) en intento ${intentos}. Reintentando en ${tiempoEspera/1000}s...`);
                await sleep(tiempoEspera);
            } else {
                throw error;
            }
        }
    }
    return null;
}

async function main() {
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.start({ phoneNumber: async () => await input.text("📱: "), password: async () => await input.text("🔐: "), phoneCode: async () => await input.text("📩: "), onError: (err) => console.log(err) });

    console.log(`✅ Conectado. Consultando Excel...`);
    const historialMap = await obtenerHistorialCompleto();

    const LIMITE_MENSAJES = 300;
    console.log(`📥 Descargando últimos ${LIMITE_MENSAJES} mensajes...`);
    const messages = await client.getMessages(targetChatId as any, { limit: LIMITE_MENSAJES });

    console.log("\n--- PROCESANDO ---");
    const resultadosFinales = [];

    let contadores = {
        exitosos: 0,
        duplicados: 0,
        error_429: 0,
        error_otros: 0,
        descartados_fecha: 0,
        descartados_nofoto: 0
    };

    for (const message of messages) {
        const msgIdStr = message.id.toString();

        // 1. FILTRO DE DUPLICADOS (PRIMERO QUE NADA)
        // Si el ID del mensaje ya existe en el Excel, lo ignoramos completamente.
        // No leemos fecha, no descargamos foto, no llamamos a Gemini.
        if (historialMap.has(msgIdStr)) {
            contadores.duplicados++;
            // console.log(`⏩ Ignorado (ID ${msgIdStr} ya procesado).`);
            continue;
        }

        const msgDate = new Date(message.date * 1000);

        // 2. Filtro Fecha (Solo procesamos mensajes del mes objetivo)
        if (msgDate.getMonth() !== TARGET_MONTH || msgDate.getFullYear() !== TARGET_YEAR) {
            contadores.descartados_fecha++;
            continue;
        }

        if (message.media && message.media.className === "MessageMediaPhoto") {
            console.log(`\n📸 [${msgDate.toLocaleDateString()}] Analizando ID: ${message.id}...`);
            const buffer = await client.downloadMedia(message, {});
            const descTelegram = message.text || "";

            if (Buffer.isBuffer(buffer)) {
                try {
                    const listaMovimientos = await analizarVoucherConGemini(buffer);

                    if (listaMovimientos && listaMovimientos.length > 0) {
                        console.log(`   ⚡ Detectados ${listaMovimientos.length} items (${listaMovimientos[0].tipo_imagen}).`);

                        for (const mov of listaMovimientos) {

                            // --- LÓGICA DE SIGNOS ---
                            let montoFinal = Math.abs(mov.monto);
                            if (mov.tipo_imagen === 'LISTA') {
                                if (!mov.es_negativo_originalmente) {
                                    montoFinal = -montoFinal;
                                }
                            } else {
                                montoFinal = Math.abs(mov.monto);
                            }

                            // --- NORMALIZACIÓN ---
                            mov.fecha = resolverFechaRelativa(mov.fecha, msgDate);
                            mov.hora = normalizarHora(mov.hora);
                            if (mov.moneda?.toLowerCase().includes('s/') || mov.moneda?.includes('soles')) mov.moneda = 'PEN';

                            const registro = {
                                ...mov,
                                monto: montoFinal,
                                descripcion_telegram: descTelegram,
                                id_mensaje: message.id // <--- ID LIMPIO (SOLO EL ID DE TELEGRAM)
                            };

                            console.log(`      ✅ OK: ${registro.fecha} | ${registro.monto} | ${registro.destinatario}`);
                            resultadosFinales.push(registro);
                            contadores.exitosos++;
                        }
                    } else {
                        console.log("   ⚠️ Gemini devolvió array vacío.");
                        contadores.error_otros++;
                    }
                } catch (err: any) {
                    if (err.toString().includes("429")) {
                        console.error("   ⛔ Error de cuota (429).");
                        contadores.error_429++;
                    } else {
                        console.error("   ❌ Error procesando:", err.message);
                        contadores.error_otros++;
                    }
                }
                await sleep(2000);
            }
        } else {
            contadores.descartados_nofoto++;
        }
    }

    if (resultadosFinales.length > 0) {
        await guardarEnGoogleSheets(resultadosFinales);
    }

    // --- REPORTE FINAL ---
    console.log("\n==================================================");
    console.log(`🏁 RESUMEN FINAL (${TARGET_MONTH + 1}/${TARGET_YEAR})`);
    console.log("==================================================");
    console.log(`✅ Procesados Exitosos:    ${contadores.exitosos}`);
    console.log(`⏭️  Duplicados Ignorados:   ${contadores.duplicados}`);
    console.log("--------------------------------------------------");
    console.log(`⛔ Fallidos por Cuota (429):${contadores.error_429}`);
    console.log(`❌ Otros Errores:           ${contadores.error_otros}`);
    console.log(`📅 Omitidos (Otro mes):     ${contadores.descartados_fecha}`);
    console.log(`📄 Omitidos (Sin foto):     ${contadores.descartados_nofoto}`);
    console.log("==================================================");

    console.log("👋 Cerrando proceso...");
    process.exit(0);
}

main();