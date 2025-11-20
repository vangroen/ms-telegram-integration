// src/utils.ts

// Convierte "5:00 p.m." -> "17:00:00"
export function normalizarHora(horaStr: string | null): string {
    if (!horaStr) return "";
    let limpio = horaStr.toLowerCase().replace(/\./g, "").trim();
    const formato24hRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (formato24hRegex.test(limpio)) return `${limpio}:00`;

    let [tiempo, modificador] = limpio.split(" ");
    if (!modificador && (limpio.includes("pm") || limpio.includes("am"))) {
        modificador = limpio.includes("pm") ? "pm" : "am";
        tiempo = limpio.replace(modificador, "");
    }
    if (!tiempo) return horaStr;

    let [horas, minutos] = tiempo.split(":").map(Number);
    if (modificador === "pm" && horas < 12) horas += 12;
    if (modificador === "am" && horas === 12) horas = 0;

    const hFinal = horas.toString().padStart(2, "0");
    const mFinal = (minutos || 0).toString().padStart(2, "0");
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