import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { GoogleGenerativeAI } from "@google/generative-ai";
// @ts-ignore
import input = require("input");
import * as dotenv from "dotenv";

import { resolverFechaRelativa, normalizarHora } from "./utils/utils";
import { obtenerHistorialCompleto, guardarEnGoogleSheets } from "./utils/sheets";

dotenv.config();

// --- UTILIDAD PARA PAUSAR (5 Segundos) ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// CONFIGURACIÓN
const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || "";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");
const targetChatId = process.env.TARGET_CHAT_ID ? BigInt(process.env.TARGET_CHAT_ID.replace(/['"]+/g, '')) : BigInt(0);
const geminiApiKey = process.env.GEMINI_API_KEY || "";

// --- LÓGICA DE FECHA HÍBRIDA ---
let targetDate: Date;

const argMes = process.argv[2];
const argAnio = process.argv[3];

if (argMes && argAnio) {
    console.log(`💻 MODO MANUAL (Local): Recibido Mes ${argMes}, Año ${argAnio}`);
    const monthIndex = Number(argMes) - 1;
    const year = Number(argAnio);
    targetDate = new Date(year, monthIndex, 1);
} else if (process.env.MANUAL_MONTH && process.env.MANUAL_YEAR) {
    console.log(`☁️ MODO MANUAL (GitHub): Recibido Mes ${process.env.MANUAL_MONTH}, Año ${process.env.MANUAL_YEAR}`);
    const monthIndex = Number(process.env.MANUAL_MONTH) - 1;
    const year = Number(process.env.MANUAL_YEAR);
    targetDate = new Date(year, monthIndex, 1);
} else {
    console.log("🤖 MODO AUTOMÁTICO (Batch): Calculando mes anterior...");
    const today = new Date();
    targetDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
}

const TARGET_MONTH = targetDate.getMonth();
const TARGET_YEAR = targetDate.getFullYear();

console.log(`📅 PERIODO A ANALIZAR: MES ${TARGET_MONTH + 1} / AÑO ${TARGET_YEAR}`);

// --- FUNCIÓN GEMINI ---
// Ahora lanzamos el error hacia afuera para que el main() lo cuente
async function analizarVoucherConGemini(imageBuffer: Buffer) {
    if (!geminiApiKey) throw new Error("Falta GEMINI_API_KEY");

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    // Usamos el modelo PRO solicitado
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

    const prompt = `
        Actúa como un OCR financiero experto. Analiza la imagen.
        Extrae los siguientes datos en JSON:
        {
            "monto": (número decimal. Ej: 26.00. Si falta, null),
            "moneda": (string, 'PEN' o 'USD' o 'S/'),
            "fecha": (string, formato YYYY-MM-DD. PRIORIDADES: 1.Fecha explícita, 2."ayer"/"hoy", 3.Barra Estado Celular), 
            "hora": (string. IMPORTANTE: Si la hora tiene AM/PM, inclúyelo (ej: "07:32 PM"). NO lo conviertas. Si está en 24h, déjalo así. Si dice "Ahora", busca en la Barra de Estado), 
            "destinatario": (string. Nombre del comercio o persona),
            "app_origen": (string. JERARQUÍA ESTRICTA: 1.Plin, 2.Yape, 3.CMR, 4.Banco específico),
            "codigo_operacion": (string o null),
            "mensaje_en_voucher": (string o null. REGLA: SOLO si es "Yape" extrae texto, sino null)
        }
    `;

    const result = await model.generateContent([
        prompt,
        { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } }
    ]);
    const text = result.response.text();
    return JSON.parse(text.replace(/```json|```/g, "").trim());
}

async function main() {
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.start({ phoneNumber: async () => await input.text("📱: "), password: async () => await input.text("🔐: "), phoneCode: async () => await input.text("📩: "), onError: (err) => console.log(err) });

    console.log(`✅ Conectado. Consultando Excel...`);
    const historialMap = await obtenerHistorialCompleto();
    console.log(`   -> Base de datos cargada con ${historialMap.size} registros.`);

    // Descargamos más mensajes para asegurar cobertura
    const LIMITE_DESCAGA = 300;
    console.log(`📥 Descargando últimos ${LIMITE_DESCAGA} mensajes...`);
    const allMessages = await client.getMessages(targetChatId as any, { limit: LIMITE_DESCAGA });

    // --- PASO 1: FILTRADO Y CONTEO PREVIO ---
    // Filtramos en memoria solo los que son del mes correcto Y tienen foto
    const mensajesCandidatos = allMessages.filter(m => {
        const d = new Date(m.date * 1000);
        return d.getMonth() === TARGET_MONTH &&
            d.getFullYear() === TARGET_YEAR &&
            m.media &&
            m.media.className === "MessageMediaPhoto";
    });

    console.log(`\n📊 RESUMEN PREVIO:`);
    console.log(`   • Mensajes totales leídos: ${allMessages.length}`);
    console.log(`   • Candidatos para procesar (Mes correcto + Foto): ${mensajesCandidatos.length}`);

    console.log("\n--- INICIANDO PROCESAMIENTO ---");

    const resultadosFinales = [];

    // Contadores
    let countExitosos = 0;
    let countDuplicados = 0;
    let countError429 = 0;
    let countErrorOtros = 0;

    // Procesamos solo los candidatos
    for (const message of mensajesCandidatos) {
        const msgIdStr = message.id.toString();

        // 1. Check Duplicados
        if (historialMap.has(msgIdStr)) {
            // const dato = historialMap.get(msgIdStr);
            // console.log(`⏩ Ignorado (Duplicado ID ${msgIdStr})`);
            countDuplicados++;
            continue;
        }

        console.log(`\n📸 [ID: ${message.id}] Procesando imagen...`);

        try {
            const buffer = await client.downloadMedia(message, {});
            const descTelegram = message.text || "";

            if (Buffer.isBuffer(buffer)) {
                // Llamada a la IA
                const datos = await analizarVoucherConGemini(buffer);

                if (datos) {
                    const msgDate = new Date(message.date * 1000);
                    datos.fecha = resolverFechaRelativa(datos.fecha, msgDate);
                    datos.hora = normalizarHora(datos.hora);
                    if (datos.moneda?.toLowerCase() === 's/') datos.moneda = 'PEN';

                    const registro = { ...datos, descripcion_telegram: descTelegram, id_mensaje: message.id };
                    console.log(`   ✅ ÉXITO: ${registro.app_origen} | ${registro.monto}`);
                    resultadosFinales.push(registro);
                    countExitosos++;
                } else {
                    console.log("   ⚠️ Gemini devolvió datos vacíos.");
                    countErrorOtros++;
                }
            }
        } catch (error: any) {
            // Detección específica de Error 429
            if (error.toString().includes("429") || error.status === 429) {
                console.error(`   ❌ ERROR 429 (Cuota Excedida) en ID ${message.id}.`);
                countError429++;
            } else {
                console.error(`   ❌ Error general en ID ${message.id}:`, error.message);
                countErrorOtros++;
            }
        }

        // --- ESPERA DE 5 SEGUNDOS ---
        console.log("   ⏳ Esperando 5s...");
        await sleep(5000);
    }

    // Guardado
    if (resultadosFinales.length > 0) {
        await guardarEnGoogleSheets(resultadosFinales);
    }

    // --- REPORTE FINAL DETALLADO ---
    console.log("\n==================================================");
    console.log(`🏁 REPORTE FINAL DE EJECUCIÓN`);
    console.log("==================================================");
    console.log(`📅 Periodo: ${TARGET_MONTH + 1}/${TARGET_YEAR}`);
    console.log(`📨 Total Candidatos:      ${mensajesCandidatos.length}`);
    console.log("--------------------------------------------------");
    console.log(`✅ Procesados Exitosos:   ${countExitosos}`);
    console.log(`⏭️  Ignorados (Duplicados):${countDuplicados}`);
    console.log(`⛔ Fallidos (Error 429):  ${countError429}`);
    console.log(`⚠️ Otros Errores:         ${countErrorOtros}`);
    console.log("==================================================");

    console.log("👋 Cerrando proceso...");
    process.exit(0);
}

main();