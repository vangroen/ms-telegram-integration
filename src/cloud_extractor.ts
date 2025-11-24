import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { GoogleGenerativeAI } from "@google/generative-ai";
// @ts-ignore
import input = require("input");
import * as dotenv from "dotenv";

// CORRECCIÓN IMPORTANTE: Apuntamos a los archivos estándar 'utils.ts' y 'sheets.ts'
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

// --- LÓGICA DE FECHA HÍBRIDA (SOPORTA LAS 3 CASUÍSTICAS) ---
let targetDate: Date;
const argMes = process.argv[2];
const argAnio = process.argv[3];

// CASO 1: Manual Local (Consola) -> npx ts-node src/data_extractor.ts 11 2025
if (argMes && argAnio) {
    console.log(`💻 MODO MANUAL (Local): Recibido Mes ${argMes}, Año ${argAnio}`);
    targetDate = new Date(Number(argAnio), Number(argMes) - 1, 1);
}
// CASO 2: Manual Nube (GitHub Actions Input) -> Se pasa por variables de entorno
else if (process.env.MANUAL_MONTH && process.env.MANUAL_YEAR) {
    console.log(`☁️ MODO MANUAL (GitHub): Recibido Mes ${process.env.MANUAL_MONTH}, Año ${process.env.MANUAL_YEAR}`);
    targetDate = new Date(Number(process.env.MANUAL_YEAR), Number(process.env.MANUAL_MONTH) - 1, 1);
}
// CASO 3: Automático (Batch/Cron) -> Toma el mes anterior
else {
    console.log("🤖 MODO AUTOMÁTICO (Batch): Calculando mes anterior...");
    const today = new Date();
    targetDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
}

const TARGET_MONTH = targetDate.getMonth();
const TARGET_YEAR = targetDate.getFullYear();

console.log(`📅 PERIODO A ANALIZAR: MES ${TARGET_MONTH + 1} / AÑO ${TARGET_YEAR}`);

// --- FUNCIÓN GEMINI CON REINTENTOS ---
async function analizarVoucherConGemini(imageBuffer: Buffer): Promise<any | null> {
    if (!geminiApiKey) return null;

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    // Usamos 2.0 Flash (Rápido y con Free Tier disponible)
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `
        Actúa como un OCR financiero experto. Analiza la imagen.
        Extrae los siguientes datos en JSON:
        {
            "monto": (número decimal. Ej: 26.00. Si falta, null),
            "moneda": (string, 'PEN' o 'USD' o 'S/'),
            "fecha": (string, formato YYYY-MM-DD. INSTRUCCIÓN CRÍTICA: Si no hay año, devuelve solo DD/MM. Si dice "ayer"/"hoy", escribe literal), 
            "hora": (string. IMPORTANTE: Si tiene AM/PM inclúyelo. NO conviertas a 24h aquí.), 
            "destinatario": (string. Nombre del comercio o persona),
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
            return JSON.parse(text.replace(/```json|```/g, "").trim());

        } catch (error: any) {
            intentos++;
            const errMsg = error.toString();
            // Reintentar si es error de cuota (429) o servidor (500)
            const esRecuperable = errMsg.includes("429") || errMsg.includes("500") || errMsg.includes("503") || error.status === 429;

            if (esRecuperable && intentos < MAX_INTENTOS) {
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
    console.log(`   -> Base de datos cargada con ${historialMap.size} registros.`);

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

        // 1. Check Duplicados
        if (historialMap.has(msgIdStr)) {
            contadores.duplicados++;
            continue;
        }

        const msgDate = new Date(message.date * 1000);

        // 2. Filtro Fecha
        if (msgDate.getMonth() === TARGET_MONTH && msgDate.getFullYear() === TARGET_YEAR) {

            if (message.media && message.media.className === "MessageMediaPhoto") {
                console.log(`\n📸 [${msgDate.toLocaleDateString()}] Nuevo mensaje detectado (ID: ${message.id})...`);
                const buffer = await client.downloadMedia(message, {});
                const descTelegram = message.text || "";

                if (Buffer.isBuffer(buffer)) {
                    try {
                        const datos = await analizarVoucherConGemini(buffer);

                        if (datos) {
                            // Normalización y limpieza
                            datos.fecha = resolverFechaRelativa(datos.fecha, msgDate);
                            datos.hora = normalizarHora(datos.hora);
                            if (datos.moneda?.toLowerCase() === 's/') datos.moneda = 'PEN';

                            const registro = { ...datos, descripcion_telegram: descTelegram, id_mensaje: message.id };
                            console.log("   ✅ PROCESADO:", registro.app_origen, "|", registro.monto, "|", registro.fecha);
                            resultadosFinales.push(registro);
                            contadores.exitosos++;
                        }
                    } catch (err: any) {
                        if (err.toString().includes("429")) {
                            console.error("   ⛔ OMITIDO: Error de cuota persistente.");
                            contadores.error_429++;
                        } else {
                            console.error("   ❌ OMITIDO: Error procesamiento:", err.message);
                            contadores.error_otros++;
                        }
                    }

                    // Pausa de seguridad para no saturar la API (incluso si hay reintentos)
                    await sleep(2000);
                }
            } else {
                contadores.descartados_nofoto++;
            }
        } else {
            contadores.descartados_fecha++;
        }
    }

    if (resultadosFinales.length > 0) {
        await guardarEnGoogleSheets(resultadosFinales);
    }

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