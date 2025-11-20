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

// FECHA A BUSCAR (Ajusta según necesites. Para pruebas con "ayer", es importante)
const TARGET_MONTH = 10; // Noviembre (0=Enero, 10=Noviembre)
const TARGET_YEAR = 2025;

// --- FUNCIÓN PARA ANALIZAR IMAGEN CON GEMINI ---
async function analizarVoucherConGemini(imageBuffer: Buffer) {
    if (!geminiApiKey) {
        console.error("❌ ERROR: Falta GEMINI_API_KEY en el archivo .env");
        return null;
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    // --- PROMPT ADAPTADO PARA NOTIFICACIONES ---
    const prompt = `
        Actúa como un sistema OCR financiero experto. Analiza esta imagen que puede ser un comprobante de pago (Yape, Plin, Banco) O UNA NOTIFICACIÓN DE PAGO (ej. de un banco por tarjeta).
        Extrae los siguientes datos y devuélvelos EXCLUSIVAMENTE en formato JSON:
        {
            "monto": (número decimal, solo el valor numérico, ej: 222.00),
            "moneda": (string, 'PEN', 'USD', 'S/' o null si no se detecta),
            "fecha": (string, formato YYYY-MM-DD. SI LA IMAGEN DICE "ayer" O "hoy", devuelve "ayer" o "hoy" LITERALMENTE. Si falta, asume null), 
            "hora": (string, formato 24h "HH:MM". Si dice 'PM', conviértelo a 24h. Si falta, null), 
            "destinatario": (string, nombre de quien recibe el pago o el comercio donde se compró. Si es una notificación, es el comercio. Si falta, null),
            "app_origen": (string, ej: 'Yape', 'Plin', 'BCP', 'Interbank' (si es una notificación de Interbank). Si falta, null),
            "codigo_operacion": (string o null. Solo si es explícito en la imagen, si no hay, null),
            "mensaje_en_voucher": (string o null. Si hay un texto de concepto o comentario DENTRO de la imagen. Si es una notificación no suele haber, pon null)
        }
        Si la imagen no contiene datos de una transacción clara, devuelve todos los campos como null.
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

// --- FUNCIÓN AUXILIAR PARA CONVERTIR "ayer" o "hoy" A FECHA REAL ---
function resolverFechaRelativa(fechaGemini: string | null, fechaMensajeTelegram: Date): string | null {
    if (!fechaGemini) return null;

    const hoy = new Date(fechaMensajeTelegram); // Usamos la fecha del mensaje de Telegram como "hoy"
    const ayer = new Date(fechaMensajeTelegram);
    ayer.setDate(hoy.getDate() - 1); // Resta un día

    if (fechaGemini.toLowerCase() === "hoy") {
        return hoy.toISOString().split('T')[0]; // Formato YYYY-MM-DD
    } else if (fechaGemini.toLowerCase() === "ayer") {
        return ayer.toISOString().split('T')[0]; // Formato YYYY-MM-DD
    } else {
        // Si ya viene con formato YYYY-MM-DD, lo devuelve.
        // O si viene en otro formato que Gemini ya haya estandarizado.
        return fechaGemini;
    }
}


async function main() {
    console.log("RC: Iniciando...");
    console.log("🎯 ID Objetivo:", targetChatId.toString());

    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.start({ phoneNumber: async () => await input.text("📱: "), password: async () => await input.text("🔐: "), phoneCode: async () => await input.text("📩: "), onError: (err) => console.log(err) });

    console.log(`✅ Conectado. Buscando transacciones de Mes: ${TARGET_MONTH + 1}/${TARGET_YEAR}...`);

    const messages = await client.getMessages(targetChatId as any, { limit: 50 });

    console.log("\n--- PROCESANDO ---");
    const resultadosFinales = [];

    for (const message of messages) {
        const msgDate = new Date(message.date * 1000); // Fecha del mensaje en Telegram

        // Filtro de Fecha (usando la fecha del mensaje de Telegram, que es la más precisa para el rango)
        if (msgDate.getMonth() === TARGET_MONTH && msgDate.getFullYear() === TARGET_YEAR) {

            if (message.media && message.media.className === "MessageMediaPhoto") {
                console.log(`\n📸 [${msgDate.toLocaleDateString()}] Foto detectada (ID: ${message.id}). Descargando...`);

                const descripcionTelegram = message.text || "";

                const buffer = await client.downloadMedia(message, {});

                if (Buffer.isBuffer(buffer)) {
                    console.log("   🧠 Enviando a Gemini...");
                    const datosVoucher = await analizarVoucherConGemini(buffer);

                    if (datosVoucher) {
                        // --- LÓGICA DE POST-PROCESAMIENTO DE FECHA ---
                        // Ajustamos la fecha que viene de Gemini (si es "ayer" o "hoy")
                        datosVoucher.fecha = resolverFechaRelativa(datosVoucher.fecha, msgDate); // <--- NUEVO

                        // Si Gemini devuelve "S/", lo estandarizamos a "PEN"
                        if (datosVoucher.moneda && datosVoucher.moneda.toLowerCase() === 's/') { // <--- NUEVO
                            datosVoucher.moneda = 'PEN';
                        }

                        const registroCompleto = {
                            ...datosVoucher,
                            descripcion_telegram: descripcionTelegram,
                            id_mensaje: message.id
                        };

                        console.log("   ✅ DATOS OBTENIDOS:");
                        console.log(registroCompleto);
                        resultadosFinales.push(registroCompleto);
                    }
                }
            }
        }
    }
    console.log(`\n🏁 Fin. Total procesados: ${resultadosFinales.length}`);
}

main();