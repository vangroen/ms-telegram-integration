import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { GoogleGenerativeAI } from "@google/generative-ai";
// @ts-ignore
import input = require("input");
import * as dotenv from "dotenv";

import { resolverFechaRelativa, normalizarHora } from "./utils/utils_modified";
import { obtenerHistorialCompleto, guardarEnGoogleSheets } from "./utils/sheets_modified";

dotenv.config();

// CONFIGURACIÓN
const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || "";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");
const targetChatId = process.env.TARGET_CHAT_ID ? BigInt(process.env.TARGET_CHAT_ID.replace(/['"]+/g, '')) : BigInt(0);
const geminiApiKey = process.env.GEMINI_API_KEY || "";

// --- LÓGICA DE FECHA HÍBRIDA (Manual Local / Manual Nube / Automático) ---
let targetDate: Date;

// 1. MODO MANUAL LOCAL (Argumentos de consola: npx ts-node src/index.ts 11 2025)
const argMes = process.argv[2]; // El primer argumento después del nombre del archivo
const argAnio = process.argv[3]; // El segundo argumento

if (argMes && argAnio) {
    console.log(`💻 MODO MANUAL (Local): Recibido Mes ${argMes}, Año ${argAnio}`);
    // Restamos 1 porque en JS Enero es 0
    const monthIndex = Number(argMes) - 1;
    const year = Number(argAnio);
    targetDate = new Date(year, monthIndex, 1);
}
// 2. MODO MANUAL NUBE (Variables de Entorno desde GitHub Actions Inputs)
else if (process.env.MANUAL_MONTH && process.env.MANUAL_YEAR) {
    console.log(`☁️ MODO MANUAL (GitHub): Recibido Mes ${process.env.MANUAL_MONTH}, Año ${process.env.MANUAL_YEAR}`);
    const monthIndex = Number(process.env.MANUAL_MONTH) - 1;
    const year = Number(process.env.MANUAL_YEAR);
    targetDate = new Date(year, monthIndex, 1);
}
// 3. MODO AUTOMÁTICO (Batch / Cron)
else {
    console.log("🤖 MODO AUTOMÁTICO (Batch): Calculando mes anterior...");
    const today = new Date();
    // Retrocedemos al día 1 del mes anterior (ej: Si hoy es 1 Dic, vamos al 1 Nov)
    targetDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
}

const TARGET_MONTH = targetDate.getMonth();
const TARGET_YEAR = targetDate.getFullYear();

console.log(`📅 PERIODO A ANALIZAR: MES ${TARGET_MONTH + 1} / AÑO ${TARGET_YEAR}`);
// --------------------------------------------------

async function analizarVoucherConGemini(imageBuffer: Buffer) {
    if (!geminiApiKey) return null;
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `
        Actúa como un OCR financiero experto. Analiza la imagen.
        Extrae los siguientes datos en JSON:
        {
            "monto": (número decimal. Ej: 26.00. Si falta, null),
            "moneda": (string, 'PEN' o 'USD' o 'S/'),
            "fecha": (string, formato YYYY-MM-DD. PRIORIDADES: 1.Fecha explícita, 2."ayer"/"hoy", 3.Barra Estado Celular), 
            "hora": (string, formato 24h "HH:MM". PRIORIDADES: 1.Hora explícita, 2.Barra Estado Celular), 
            "destinatario": (string. Nombre del comercio o persona),
            
            "app_origen": (string. JERARQUÍA ESTRICTA:
                1. Si ves "Plin" -> "Plin".
                2. Si ves "Yape" -> "Yape".
                3. Si ves "CMR" -> "CMR".
                4. Si ves logos o texto de "Interbank" -> "Interbank".  
                5. Si no es ninguno de los anteriores -> Nombre del Banco.
            ),

            "codigo_operacion": (string o null),
            "mensaje_en_voucher": (string o null. REGLA: SOLO si es "Yape" extrae texto, sino null)
        }
    `;

    try {
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } }
        ]);
        const text = result.response.text();
        return JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch (e) { return null; }
}

async function main() {
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.start({ phoneNumber: async () => await input.text("📱: "), password: async () => await input.text("🔐: "), phoneCode: async () => await input.text("📩: "), onError: (err) => console.log(err) });

    console.log(`✅ Conectado. Consultando Excel...`);

    const historialMap = await obtenerHistorialCompleto();
    console.log(`   -> Base de datos cargada con ${historialMap.size} registros.`);

    const messages = await client.getMessages(targetChatId as any, { limit: 50 });

    console.log("\n--- PROCESANDO ---");
    const resultadosFinales = [];
    let conteoIgnorados = 0;

    for (const message of messages) {
        const msgIdStr = message.id.toString();

        if (historialMap.has(msgIdStr)) {
            const datoPrevio = historialMap.get(msgIdStr);
            console.log(`⏩ Ignorado (Duplicado ID ${msgIdStr}): ${datoPrevio.app} - ${datoPrevio.moneda} ${datoPrevio.monto}`);
            conteoIgnorados++;
            continue;
        }

        const msgDate = new Date(message.date * 1000);
        // Filtro de Mes y Año
        if (msgDate.getMonth() === TARGET_MONTH && msgDate.getFullYear() === TARGET_YEAR) {
            if (message.media && message.media.className === "MessageMediaPhoto") {
                console.log(`\n📸 [${msgDate.toLocaleDateString()}] Nuevo mensaje detectado (ID: ${message.id})...`);
                const buffer = await client.downloadMedia(message, {});
                const descTelegram = message.text || "";

                if (Buffer.isBuffer(buffer)) {
                    const datos = await analizarVoucherConGemini(buffer);
                    if (datos) {
                        datos.fecha = resolverFechaRelativa(datos.fecha, msgDate);
                        datos.hora = normalizarHora(datos.hora);
                        if (datos.moneda?.toLowerCase() === 's/') datos.moneda = 'PEN';

                        const registro = { ...datos, descripcion_telegram: descTelegram, id_mensaje: message.id };
                        console.log("   ✅ PROCESADO:", registro.app_origen, registro.monto);
                        resultadosFinales.push(registro);
                    }
                }
            }
        }
    }

    if (resultadosFinales.length > 0) {
        await guardarEnGoogleSheets(resultadosFinales);
    }

    console.log("\n--------------------------------------------------");
    console.log(`🏁 FIN DEL PROCESO`);
    console.log(`   📥 Nuevos guardados: ${resultadosFinales.length}`);
    console.log(`   ⏭️  Ignorados (duplicados): ${conteoIgnorados}`);
    console.log("--------------------------------------------------");

    console.log("👋 Cerrando proceso...");
    process.exit(0);
}

main();