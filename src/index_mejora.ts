import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { GoogleGenerativeAI } from "@google/generative-ai";
// @ts-ignore
import input = require("input");
import * as dotenv from "dotenv";

dotenv.config();

// --- CONFIGURACIÓN ---
const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || "";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");
const targetChatId = process.env.TARGET_CHAT_ID ? BigInt(process.env.TARGET_CHAT_ID.replace(/['"]+/g, '')) : BigInt(0);
const geminiApiKey = process.env.GEMINI_API_KEY || "";

// FECHA A BUSCAR
const TARGET_MONTH = 10; // Noviembre
const TARGET_YEAR = 2025;

// --- FUNCIÓN PARA ANALIZAR IMAGEN CON GEMINI ---
async function analizarVoucherConGemini(imageBuffer: Buffer) {
    if (!geminiApiKey) {
        console.error("❌ ERROR: Falta GEMINI_API_KEY en el archivo .env");
        return null;
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    // --- PROMPT MEJORADO PARA PLIN ---
    const prompt = `
        Actúa como un sistema OCR financiero experto. Analiza esta imagen que puede ser un comprobante de pago o notificación.
        Extrae los siguientes datos y devuélvelos EXCLUSIVAMENTE en formato JSON:
        {
            "monto": (número decimal, solo el valor numérico),
            "moneda": (string, 'PEN', 'USD', 'S/' o null),
            "fecha": (string, formato YYYY-MM-DD. Si dice "ayer"/"hoy", devuelve literal "ayer"/"hoy"), 
            "hora": (string, formato 24h "HH:MM". Si dice 'PM', conviértelo), 
            "destinatario": (string, nombre de quien recibe o comercio),
            
            "app_origen": (string. REGLA DE PRIORIDAD: Si detectas la palabra o logo "Plin" en CUALQUIER parte de la imagen, este campo DEBE ser "Plin" (aunque veas logos de Interbank/BBVA). Si ves "Yape", es "Yape". Solo si NO hay rastro de Plin/Yape, pon el nombre del banco, ej: "Interbank"),
            
            "codigo_operacion": (string o null),
            "mensaje_en_voucher": (string o null. Busca texto de concepto/mensaje en la imagen)
        }
        Si la imagen no contiene datos financieros, devuelve null.
    `;

    try {
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: imageBuffer.toString("base64"),
                    mimeType: "image/jpeg",
                },
            },
        ]);

        const text = result.response.text();
        const jsonString = text.replace(/```json|```/g, "").trim();

        return JSON.parse(jsonString);
    } catch (error) {
        console.error("❌ Error en Gemini:", error);
        return null;
    }
}

// --- FUNCIÓN AUXILIAR FECHAS ---
function resolverFechaRelativa(fechaGemini: string | null, fechaMensajeTelegram: Date): string | null {
    if (!fechaGemini) return null;

    const hoy = new Date(fechaMensajeTelegram);
    const ayer = new Date(fechaMensajeTelegram);
    ayer.setDate(hoy.getDate() - 1);

    if (fechaGemini.toLowerCase() === "hoy") {
        return hoy.toISOString().split('T')[0];
    } else if (fechaGemini.toLowerCase() === "ayer") {
        return ayer.toISOString().split('T')[0];
    } else {
        return fechaGemini;
    }
}

async function main() {
    console.log("RC: Iniciando...");
    console.log("🎯 ID Objetivo:", targetChatId.toString());

    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.start({ phoneNumber: async () => await input.text("📱: "), password: async () => await input.text("🔐: "), phoneCode: async () => await input.text("📩: "), onError: (err) => console.log(err) });

    console.log(`✅ Conectado. Buscando...`);

    const messages = await client.getMessages(targetChatId as any, { limit: 50 });

    console.log("\n--- PROCESANDO ---");
    const resultadosFinales = [];

    for (const message of messages) {
        const msgDate = new Date(message.date * 1000);

        if (msgDate.getMonth() === TARGET_MONTH && msgDate.getFullYear() === TARGET_YEAR) {

            if (message.media && message.media.className === "MessageMediaPhoto") {
                console.log(`\n📸 [${msgDate.toLocaleDateString()}] Foto detectada (ID: ${message.id})...`);

                const descripcionTelegram = message.text || "";
                const buffer = await client.downloadMedia(message, {});

                if (Buffer.isBuffer(buffer)) {
                    console.log("   🧠 Analizando...");
                    const datosVoucher = await analizarVoucherConGemini(buffer);

                    if (datosVoucher) {
                        datosVoucher.fecha = resolverFechaRelativa(datosVoucher.fecha, msgDate);

                        if (datosVoucher.moneda && datosVoucher.moneda.toLowerCase() === 's/') {
                            datosVoucher.moneda = 'PEN';
                        }

                        const registroCompleto = {
                            ...datosVoucher,
                            descripcion_telegram: descripcionTelegram,
                            id_mensaje: message.id
                        };

                        console.log("   ✅ RESULTADO:");
                        console.log(registroCompleto);
                        resultadosFinales.push(registroCompleto);
                    }
                }
            }
        }
    }
    console.log(`\n🏁 Fin. Total: ${resultadosFinales.length}`);
}

main();