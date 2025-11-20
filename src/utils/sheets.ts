import { google } from "googleapis";
import * as dotenv from "dotenv";

dotenv.config();
const spreadsheetId = process.env.SPREADSHEET_ID || "";

const auth = new google.auth.GoogleAuth({
    keyFile: "google-credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// 1. LEER TODO EL HISTORIAL (IDs + Detalles)
// Devuelve un MAPA donde la clave es el ID de Telegram y el valor son los datos
export async function obtenerHistorialCompleto(): Promise<Map<string, any>> {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: "Hoja 1!A:J", // Leemos desde la Columna A hasta la J (donde está el ID)
        });

        const rows = response.data.values;
        const historial = new Map<string, any>();

        if (!rows || rows.length === 0) return historial;

        // Recorremos las filas (saltando la cabecera si es necesario, pero el Map lo maneja)
        rows.forEach((row) => {
            // Asumiendo que el ID de Telegram está en la columna J (índice 9)
            // Columnas: 0:Fecha, 1:Hora, 2:Monto, 3:Moneda, ..., 5:App, ..., 9:ID
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
        console.warn("⚠️ No se pudo leer el historial (quizás es la primera vez).");
        return new Map();
    }
}

// 2. Guardar nuevos registros (Igual que antes)
export async function guardarEnGoogleSheets(nuevosRegistros: any[]) {
    if (nuevosRegistros.length === 0) return;
    console.log(`📊 Guardando ${nuevosRegistros.length} registros en Excel...`);

    const valoresParaInsertar = nuevosRegistros.map(r => [
        r.fecha, r.hora, r.monto, r.moneda, r.destinatario,
        r.app_origen, r.codigo_operacion, r.descripcion_telegram,
        r.mensaje_en_voucher, r.id_mensaje.toString()
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