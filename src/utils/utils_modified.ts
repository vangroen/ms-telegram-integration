// src/utils/utils_modified.ts

export function normalizarHora(horaStr: string | null): string {
    if (!horaStr) return "";
    const limpio = horaStr.toLowerCase().trim();
    const esPM = /p\.?\s*m\.?/.test(limpio);
    const esAM = /a\.?\s*m\.?/.test(limpio);
    const matchTiempo = limpio.match(/(\d{1,2})[:.](\d{2})/);

    if (!matchTiempo) return horaStr;

    let horas = Number(matchTiempo[1]);
    let minutos = Number(matchTiempo[2]);

    if (esPM && horas < 12) horas += 12;
    else if (esAM && horas === 12) horas = 0;

    const hFinal = horas.toString().padStart(2, "0");
    const mFinal = minutos.toString().padStart(2, "0");
    return `${hFinal}:${mFinal}:00`;
}

// Convierte texto a YYYY-MM-DD, inyectando el año si falta
export function normalizarFecha(fechaStr: string | null, anioReferencia: number): string {
    if (!fechaStr) return "";

    let limpio = fechaStr.toLowerCase().trim();

    // 1. Diccionario de meses para convertir texto a número
    const meses: { [key: string]: string } = {
        "ene": "01", "feb": "02", "mar": "03", "abr": "04", "may": "05", "jun": "06",
        "jul": "07", "ago": "08", "sep": "09", "oct": "10", "nov": "11", "dic": "12",
        "enero": "01", "febrero": "02", "marzo": "03", "abril": "04", "mayo": "05", "junio": "06",
        "julio": "07", "agosto": "08", "septiembre": "09", "octubre": "10", "noviembre": "11", "diciembre": "12"
    };

    // Reemplazar nombres de meses por " / numero / " para facilitar parseo
    for (const [nombre, numero] of Object.entries(meses)) {
        if (limpio.includes(nombre)) {
            // "22 de noviembre" -> "22 de 11" -> luego limpiamos el "de"
            limpio = limpio.replace(nombre, `/${numero}/`);
            break;
        }
    }

    // 2. Limpieza de caracteres no numéricos (dejamos solo números y separadores / -)
    // "22 de /11/" -> "22/11"
    limpio = limpio.replace(/[^0-9\/-]/g, "/").replace(/\/+/g, "/");

    // Quitamos slashes al inicio/final
    if (limpio.startsWith("/")) limpio = limpio.substring(1);
    if (limpio.endsWith("/")) limpio = limpio.substring(0, limpio.length - 1);

    // 3. Detectar si tiene año (4 dígitos)
    const partes = limpio.split(/[\/-]/);
    let dia, mes, anio;

    if (partes.length === 3) {
        // Caso completo: 22/11/2022 o 2022/11/22
        if (partes[0].length === 4) {
            // YYYY-MM-DD
            anio = parseInt(partes[0]); mes = parseInt(partes[1]); dia = parseInt(partes[2]);
        } else {
            // DD-MM-YYYY
            dia = parseInt(partes[0]); mes = parseInt(partes[1]); anio = parseInt(partes[2]);
        }
    } else if (partes.length === 2) {
        // Caso SIN AÑO: 22/11
        dia = parseInt(partes[0]);
        mes = parseInt(partes[1]);
        anio = anioReferencia; // <--- AQUÍ USAMOS TU AÑO DE PARÁMETRO (2025)
    } else {
        return fechaStr; // No pudimos entender el formato
    }

    // 4. Construir fecha ISO manual para evitar líos de zona horaria de Date()
    const yyyy = anio.toString();
    const mm = mes.toString().padStart(2, '0');
    const dd = dia.toString().padStart(2, '0');

    return `${yyyy}-${mm}-${dd}`;
}

export function resolverFechaRelativa(fechaGemini: string | null, fechaMensajeTelegram: Date): string {
    if (!fechaGemini) return "";

    const hoy = new Date(fechaMensajeTelegram);
    const ayer = new Date(fechaMensajeTelegram);
    ayer.setDate(hoy.getDate() - 1);

    // El año correcto viene de la fecha del mensaje de Telegram
    const anioRef = fechaMensajeTelegram.getFullYear();

    let fechaFinal = fechaGemini;

    // Si es vacio o null, usamos la fecha del mensaje
    if (!fechaFinal || fechaFinal.trim() === "") return hoy.toISOString().split('T')[0];

    if (fechaFinal.toLowerCase().includes("hoy")) return hoy.toISOString().split('T')[0];
    if (fechaFinal.toLowerCase().includes("ayer")) return ayer.toISOString().split('T')[0];

    // Normalizamos pasando el año de referencia
    return normalizarFecha(fechaFinal, anioRef);
}