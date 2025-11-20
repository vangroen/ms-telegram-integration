import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { google } from "googleapis";
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
const spreadsheetId = process.env.SPREADSHEET_ID || "";

// FECHA A BUSCAR
const TARGET_MONTH = 10; // Noviembre
const TARGET_YEAR = 2025;

// --- 1. UTILERÍAS DE NORMALIZACIÓN (NUEVO) ---

// Convierte "5:00 p.m.", "05 PM", "17:00" -> "17:00:00"
function normalizarHora(horaStr: string | null): string {
    if (!horaStr) return "";

    // Limpiamos el string (quitamos puntos, espacios extra, pasamos a minusculas)
    let limpio = horaStr.toLowerCase().replace(/\./g, "").trim(); // "5:13 pm"

    // Si ya está en formato 24h simple (ej: "14:30"), agregamos segundos y listo
    const formato24hRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (formato24hRegex.test(limpio)) {
        return `${limpio}:00`;
    }

    // Lógica AM/PM
    let [tiempo, modificador] = limpio.split(" ");
    // Si no hay espacio (ej: "5:00pm"), intentamos separar
    if (!modificador && (limpio.includes("pm") || limpio.includes("am"))) {
        modificador = limpio.includes("pm") ? "pm" : "am";
        tiempo = limpio.replace(modificador, "");
    }

    if (!tiempo) return horaStr; // Si falla, devuelve el original

    let [horas, minutos] = tiempo.split(":").map(Number);

    if (modificador === "pm" && horas < 12) horas += 12;
    if (modificador === "am" && horas === 12) horas = 0;

    // Formateamos con ceros a la izquierda (Padding)
    const hFinal = horas.toString().padStart(2, "0");
    const mFinal = (minutos || 0).toString().padStart(2, "0");

    return `${hFinal}:${mFinal}:00`;
}

// Convierte "16 nov 2025", "15/11/25" -> "2025-11-16"
function normalizarFecha(fechaStr: string | null): string {
    if (!fechaStr) return "";

    // Diccionario de meses español
    const meses: { [key: string]: string } = {
        "ene": "01", "feb": "02", "mar": "03", "abr": "04", "may": "05", "jun": "06",
        "jul": "07", "ago": "08", "sep": "09", "oct": "10", "nov": "11", "dic": "12",
        "enero": "01", "febrero": "02", "marzo": "03", "abril": "04", "mayo": "05", "junio": "06",
        "julio": "07", "agosto": "08", "septiembre": "09", "octubre": "10", "noviembre": "11", "diciembre": "12"
    };

    let limpio = fechaStr.toLowerCase().replace(/\./g, "").trim();

    // Si viene como texto "16 nov 2025"
    for (const [nombre, numero] of Object.entries(meses)) {
        if (limpio.includes(nombre)) {
            // Reemplazamos el nombre por el número para que el Date de JS lo entienda mejor
            limpio = limpio.replace(nombre, numero);
            break;
        }
    }

    // Intentamos que JavaScript lo parsee
    const fechaObj = new Date(limpio);

    if (!isNaN(fechaObj.getTime())) {
        return fechaObj.toISOString().split('T')[0]; // Retorna YYYY-MM-DD
    }

    return fechaStr; // Si falla, devuelve original
}

// --- 2. FUNCIÓN GEMINI ---
async function analizarVoucherConGemini(imageBuffer: Buffer) {
    if (!geminiApiKey) return null;
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `
        Actúa como OCR financiero. Analiza la imagen.
        Extrae JSON EXCLUSIVAMENTE:
        {
            "monto": (número),
            "moneda": (string, 'PEN' o 'USD'),
            "fecha": (string, PREFERIBLE: formato YYYY-MM-DD. Si dice 'ayer', pon 'ayer'),
            "hora": (string, formato 24h 'HH:MM' preferible, pero si hay AM/PM extraelo tal cual),
            "destinatario": (string),
            "app_origen": (string, Regla: Si ves 'Plin' es 'Plin'. Si ves 'Yape' es 'Yape'),
            "codigo_operacion": (string o null),
            "mensaje_en_voucher": (string o null)
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

function resolverFechaRelativa(fechaGemini: string | null, fechaMensajeTelegram: Date): string {
    if (!fechaGemini) return "";
    const hoy = new Date(fechaMensajeTelegram);
    const ayer = new Date(fechaMensajeTelegram);
    ayer.setDate(hoy.getDate() - 1);

    let fechaFinal = fechaGemini;
    if (fechaGemini.toLowerCase() === "hoy") fechaFinal = hoy.toISOString().split('T')[0];
    else if (fechaGemini.toLowerCase() === "ayer") fechaFinal = ayer.toISOString().split('T')[0];

    // APLICAMOS LA NORMALIZACIÓN AQUÍ TAMBIÉN
    return normalizarFecha(fechaFinal);
}

// --- 3. GUARDAR EN SHEETS ---
async function guardarEnGoogleSheets(nuevosRegistros: any[]) {
    if (nuevosRegistros.length === 0) return;
    console.log(`📊 Guardando ${nuevosRegistros.length} registros...`);
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: "google-credentials.json",
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        const sheets = google.sheets({ version: "v4", auth });

        const valoresParaInsertar = nuevosRegistros.map(r => [
            r.fecha, r.hora, r.monto, r.moneda, r.destinatario,
            r.app_origen, r.codigo_operacion, r.descripcion_telegram,
            r.mensaje_en_voucher, r.id_mensaje.toString()
        ]);

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: "Hoja 1!A:J",
            valueInputOption: "USER_ENTERED", // Deja que Google detecte el formato
            requestBody: { values: valoresParaInsertar },
        });
        console.log("✅ ¡GUARDADO!");
    } catch (error) { console.error("❌ Error Sheets:", error); }
}

// --- MAIN ---
async function main() {
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.start({ phoneNumber: async () => await input.text("📱: "), password: async () => await input.text("🔐: "), phoneCode: async () => await input.text("📩: "), onError: (err) => console.log(err) });

    console.log(`✅ Conectado. Leyendo...`);
    const messages = await client.getMessages(targetChatId as any, { limit: 50 });

    console.log("\n--- PROCESANDO ---");
    const resultadosFinales = [];

    for (const message of messages) {
        const msgDate = new Date(message.date * 1000);
        if (msgDate.getMonth() === TARGET_MONTH && msgDate.getFullYear() === TARGET_YEAR) {
            if (message.media && message.media.className === "MessageMediaPhoto") {
                console.log(`\n📸 [${msgDate.toLocaleDateString()}] Detectado ID: ${message.id}`);
                const buffer = await client.downloadMedia(message, {});
                const descTelegram = message.text || "";

                if (Buffer.isBuffer(buffer)) {
                    const datos = await analizarVoucherConGemini(buffer);
                    if (datos) {
                        // 1. Resolvemos "ayer/hoy" y normalizamos formato FECHA
                        datos.fecha = resolverFechaRelativa(datos.fecha, msgDate);

                        // 2. Normalizamos formato HORA (Aquí ocurre la magia)
                        datos.hora = normalizarHora(datos.hora); // <--- APLICA EL FORMATO 20:00:00

                        if (datos.moneda?.toLowerCase() === 's/') datos.moneda = 'PEN';

                        const registro = { ...datos, descripcion_telegram: descTelegram, id_mensaje: message.id };
                        console.log("   ✅ OK:", registro.fecha, registro.hora, registro.monto);
                        resultadosFinales.push(registro);
                    }
                }
            }
        }
    }

    if (resultadosFinales.length > 0) await guardarEnGoogleSheets(resultadosFinales);
    console.log("🏁 Fin.");
}

main();