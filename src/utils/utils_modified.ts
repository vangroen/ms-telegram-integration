// src/utils/utils_modified.ts

// Convierte cualquier formato ("02:24 p. m.", "2:24PM", "07:32 PM") -> "19:32:00"
export function normalizarHora(horaStr: string | null): string {
    if (!horaStr) return "";

    // 1. Limpieza básica y minúsculas
    const limpio = horaStr.toLowerCase().trim();
    // Ejemplo entrada: "07:32 pm" -> limpio: "07:32 pm"

    // 2. Detección Inteligente de PM (busca 'p' seguida de cualquier cosa y luego 'm')
    // Esto cubre: "pm", "p.m.", "p m", "p. m.", "PM"
    const esPM = /p\.?\s*m\.?/.test(limpio);
    const esAM = /a\.?\s*m\.?/.test(limpio);

    // 3. Extracción de Números (Horas y Minutos)
    // Usamos una regex que capture grupos: (digitos):(digitos)
    // Esto ignora cualquier texto extra alrededor
    const matchTiempo = limpio.match(/(\d{1,2})[:.](\d{2})/);

    if (!matchTiempo) return horaStr; // Si no encuentra números, devuelve original

    let horas = Number(matchTiempo[1]);
    let minutos = Number(matchTiempo[2]);

    // 4. Matemáticas de Conversión 24h
    if (esPM && horas < 12) {
        horas += 12; // 7 PM -> 19
    } else if (esAM && horas === 12) {
        horas = 0;   // 12 AM -> 00
    }
    // Nota: Si no detecta ni PM ni AM, asume que ya es formato 24h o 12h mediodía

    // 5. Formateo Final (HH:MM:00)
    const hFinal = horas.toString().padStart(2, "0");
    const mFinal = minutos.toString().padStart(2, "0");

    return `${hFinal}:${mFinal}:00`;
}

// Convierte texto a YYYY-MM-DD
export function normalizarFecha(fechaStr: string | null): string {
    if (!fechaStr) return "";
    const meses: { [key: string]: string } = {
        "ene": "01", "feb": "02", "mar": "03", "abr": "04", "may": "05", "jun": "06",
        "jul": "07", "ago": "08", "sep": "09", "oct": "10", "nov": "11", "dic": "12",
        "enero": "01", "febrero": "02", "marzo": "03", "abril": "04", "mayo": "05", "junio": "06",
        "julio": "07", "agosto": "08", "septiembre": "09", "octubre": "10", "noviembre": "11", "diciembre": "12"
    };
    let limpio = fechaStr.toLowerCase().replace(/\./g, "").trim();
    for (const [nombre, numero] of Object.entries(meses)) {
        if (limpio.includes(nombre)) {
            limpio = limpio.replace(nombre, numero);
            break;
        }
    }
    const fechaObj = new Date(limpio);
    if (!isNaN(fechaObj.getTime())) return fechaObj.toISOString().split('T')[0];
    return fechaStr;
}

// Resuelve "ayer/hoy"
export function resolverFechaRelativa(fechaGemini: string | null, fechaMensajeTelegram: Date): string {
    if (!fechaGemini) return "";
    const hoy = new Date(fechaMensajeTelegram);
    const ayer = new Date(fechaMensajeTelegram);
    ayer.setDate(hoy.getDate() - 1);

    let fechaFinal = fechaGemini;
    if (fechaGemini.toLowerCase() === "hoy") fechaFinal = hoy.toISOString().split('T')[0];
    else if (fechaGemini.toLowerCase() === "ayer") fechaFinal = ayer.toISOString().split('T')[0];

    return normalizarFecha(fechaFinal);
}