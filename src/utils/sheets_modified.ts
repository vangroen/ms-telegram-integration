import { google } from "googleapis";
import * as dotenv from "dotenv";

dotenv.config();
const spreadsheetId = process.env.SPREADSHEET_ID || "";

// --- CONFIGURACIÓN DE AUTENTICACIÓN HÍBRIDA ---
let authConfig: any = {
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
};

// 1. Si estamos en GitHub Actions (variable de entorno), usamos el JSON de memoria
if (process.env.GOOGLE_CREDENTIALS_JSON) {
    try {
        authConfig.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        console.log("🔐 Usando credenciales desde memoria (GitHub Secrets).");
    } catch (error) {
        console.error("❌ Error parseando GOOGLE_CREDENTIALS_JSON:", error);
    }
}
// 2. Si no, usamos el archivo físico (desarrollo local)
else {
    authConfig.keyFile = "google-credentials.json";
    console.log("📂 Usando credenciales desde archivo local.");
}

const auth = new google.auth.GoogleAuth(authConfig);
const sheets = google.sheets({ version: "v4", auth });

// --- FUNCIONES ---

// Obtiene todos los registros actuales para evitar duplicados
export async function obtenerHistorialCompleto(): Promise<Map<string, any>> {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: "Hoja 1!A:J", // Asegúrate que coincida con el nombre de tu hoja
        });

        const rows = response.data.values;
        const historial = new Map<string, any>();

        if (!rows || rows.length === 0) return historial;

        rows.forEach((row) => {
            // Asumimos que el ID de Telegram está en la columna J (índice 9)
            const idTelegram = row[9];
            if (idTelegram) {
                historial.set(idTelegram.toString(), {
                    fecha: row[0],
                    hora: row[1],
                    monto: row[2],
                    moneda: row[3],
                    app: row[5]
                });
            }
        });

        return historial;
    } catch (error) {
        console.warn("⚠️ No se pudo leer el historial (quizás es la primera ejecución).", error);
        return new Map();
    }
}

// Guarda los nuevos registros al final de la hoja
export async function guardarEnGoogleSheets(nuevosRegistros: any[]) {
    if (nuevosRegistros.length === 0) return;
    console.log(`📊 Guardando ${nuevosRegistros.length} registros en Excel...`);

    const valoresParaInsertar = nuevosRegistros.map(r => [
        r.fecha,
        r.hora,
        r.monto,
        r.moneda,
        r.destinatario,
        r.app_origen,
        r.codigo_operacion,
        r.descripcion_telegram,
        r.mensaje_en_voucher,
        r.id_mensaje.toString()
    ]);

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: "Hoja 1!A:J",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: valoresParaInsertar },
        });
        console.log("✅ ¡GUARDADO EXITOSO!");
    } catch (error) {
        console.error("❌ Error guardando en Google Sheets:", error);
    }
}