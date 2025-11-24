import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { GoogleGenerativeAI } from "@google/generative-ai";
// @ts-ignore
import input = require("input");
import * as dotenv from "dotenv";

// Asegúrate de que tus archivos de utilidades estén bien importados
import { resolverFechaRelativa, normalizarHora } from "./utils/utils";
import { obtenerHistorialCompleto, guardarEnGoogleSheets } from "./utils/sheets";

dotenv.config();

// CONFIGURACIÓN
const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || "";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");
const targetChatId = process.env.TARGET_CHAT_ID ? BigInt(process.env.TARGET_CHAT_ID.replace(/['"]+/g, '')) : BigInt(0);
const geminiApiKey = process.env.GEMINI_API_KEY || "";

// --- LÓGICA DE FECHA HÍBRIDA ---
let targetDate: Date;

// 1. MODO MANUAL LOCAL
const argMes = process.argv[2];
const argAnio = process.argv[3];

if (argMes && argAnio) {
    console.log(`💻 MODO MANUAL (Local): Recibido Mes ${argMes}, Año ${argAnio}`);
    const monthIndex = Number(argMes) - 1;
    const year = Number(argAnio);
    targetDate = new Date(year, monthIndex, 1);
}
// 2. MODO MANUAL NUBE
else if (process.env.MANUAL_MONTH && process.env.MANUAL_YEAR) {
    console.log(`☁️ MODO MANUAL (GitHub): Recibido Mes ${process.env.MANUAL_MONTH}, Año ${process.env.MANUAL_YEAR}`);
    const monthIndex = Number(process.env.MANUAL_MONTH) - 1;
    const year = Number(process.env.MANUAL_YEAR);
    targetDate = new Date(year, monthIndex, 1);
}
// 3. MODO AUTOMÁTICO
else {
    console.log("🤖 MODO AUTOMÁTICO (Batch): Calculando mes anterior...");
    const today = new Date();
    targetDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
}

const TARGET_MONTH = targetDate.getMonth();
const TARGET_YEAR = targetDate.getFullYear();

console.log(`📅 PERIODO A ANALIZAR: MES ${TARGET_MONTH + 1} / AÑO ${TARGET_YEAR}`);
// --------------------------------------------------

async function analizarVoucherConGemini(imageBuffer: Buffer) {
    if (!geminiApiKey) return null;
    const genAI = new GoogleGenerativeAI(geminiApiKey);

    // USAMOS EL MODELO PRO ESTABLE (1.5 Pro)
    // Este modelo tiene límites muy altos en cuentas pagas y es más inteligente que Flash.
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

    const prompt = `
        Actúa como un OCR financiero experto. Analiza la imagen.
        Extrae los siguientes datos en JSON:
        {
            "monto": (número decimal. Ej: 26.00. Si falta, null),
            "moneda": (string, 'PEN' o 'USD' o 'S/'),
            
            "fecha": (string, formato YYYY-MM-DD. PRIORIDADES: 1.Fecha explícita, 2."ayer"/"hoy", 3.Barra Estado Celular), 
            
            "hora": (string. IMPORTANTE: Si la hora tiene AM/PM, inclúyelo (ej: "07:32 PM"). NO lo conviertas. Si está en 24h, déjalo así.), 
            
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
    } catch (e) {
        console.error("❌ Error procesando imagen con Gemini:", e);
        return null;
    }
}

async function main() {
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.start({ phoneNumber: async () => await input.text("📱: "), password: async () => await input.text("🔐: "), phoneCode: async () => await input.text("📩: "), onError: (err) => console.log(err) });

    console.log(`✅ Conectado. Consultando Excel...`);

    const historialMap = await obtenerHistorialCompleto();
    console.log(`   -> Base de datos cargada con ${historialMap.size} registros.`);

    // LÍMITE AUMENTADO A 300 PARA CUENTAS PRO
    const LIMITE_MENSAJES = 300;
    console.log(`📥 Descargando últimos ${LIMITE_MENSAJES} mensajes...`);
    const messages = await client.getMessages(targetChatId as any, { limit: LIMITE_MENSAJES });

    console.log("\n--- PROCESANDO A MÁXIMA VELOCIDAD 🚀 ---");
    const resultadosFinales = [];
    let conteoIgnorados = 0;

    // Procesamos los mensajes en PARALELO (para ir aún más rápido)
    // OJO: Si prefieres mantener el orden estricto, usa el 'for...of' normal.
    // Aquí mantengo el 'for...of' para estabilidad, pero sin el 'sleep'.

    for (const message of messages) {
        const msgIdStr = message.id.toString();

        if (historialMap.has(msgIdStr)) {
            conteoIgnorados++;
            continue;
        }

        const msgDate = new Date(message.date * 1000);

        if (msgDate.getMonth() === TARGET_MONTH && msgDate.getFullYear() === TARGET_YEAR) {
            if (message.media && message.media.className === "MessageMediaPhoto") {
                console.log(`\n📸 [${msgDate.toLocaleDateString()}] Nuevo mensaje (ID: ${message.id})...`);
                const buffer = await client.downloadMedia(message, {});
                const descTelegram = message.text || "";

                if (Buffer.isBuffer(buffer)) {
                    // SIN SLEEP: Ejecución directa
                    const datos = await analizarVoucherConGemini(buffer);

                    if (datos) {
                        datos.fecha = resolverFechaRelativa(datos.fecha, msgDate);
                        datos.hora = normalizarHora(datos.hora);
                        if (datos.moneda?.toLowerCase() === 's/') datos.moneda = 'PEN';

                        const registro = { ...datos, descripcion_telegram: descTelegram, id_mensaje: message.id };
                        console.log("   ✅ PROCESADO:", registro.app_origen, registro.monto);
                        resultadosFinales.push(registro);
                    } else {
                        console.log("   ⚠️ Gemini falló o devolvió null.");
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