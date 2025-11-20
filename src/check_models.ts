import * as dotenv from "dotenv";
// BORRADA LA LÍNEA DE UNDICI

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

async function listModels() {
    if (!apiKey) {
        console.error("❌ No hay API KEY en el .env");
        return;
    }

    console.log("🔍 Consultando a Google qué modelos tienes disponibles...");

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

    try {
        // Node.js moderno usa fetch nativo
        const response = await fetch(url);
        const data = await response.json() as any;

        if (data.error) {
            console.error("❌ Error de la API:", data.error.message);
            return;
        }

        console.log("\n✅ MODELOS DISPONIBLES PARA TU CUENTA:");
        console.log("-------------------------------------");

        if (data.models) {
            data.models.forEach((model: any) => {
                if (model.supportedGenerationMethods.includes("generateContent")) {
                    console.log(`🔹 ${model.name}`); // Copia esto
                }
            });
            console.log("\n👉 COPIA uno de los nombres que empiezan por 'models/'");
        } else {
            console.log("⚠️ No se encontraron modelos listados.");
        }

    } catch (error) {
        console.error("❌ Error de conexión:", error);
    }
}

listModels();